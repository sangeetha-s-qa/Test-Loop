import crypto from "node:crypto";
import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { conflict, fail, forbidden, notFound, route, registerUuidParams } from "../http";
import { createSession, requireAuth, type AuthRequest } from "../middleware/auth";
import { signupSchema } from "../validation";
import { doneStatuses } from "../bugs/workflow";

/**
 * Workspace members and invitations.
 *
 * An invitation is a one-time link. Only an HMAC of its token is stored, the link is shown once to
 * the person who created it, and they send it however they like - so joining works whether or not
 * email delivery is configured.
 */

export const teamRouter = Router();
registerUuidParams(teamRouter);

const roles = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
const teams = ["QA", "DEVELOPER", "PRODUCT", "DESIGN", "OTHER"] as const;
const INVITE_TTL_DAYS = 7;

const isManager = (role: string) => role === "OWNER" || role === "ADMIN";
const hashToken = (token: string) => crypto.createHmac("sha256", config.SESSION_SECRET).update(`invite:${token}`).digest("hex");
const sessionCookie = (response: Response, token: string) => response.cookie("qa_session", token, { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });

const inviteSelect = { id: true, email: true, role: true, team: true, expiresAt: true, createdAt: true, invitedBy: { select: { id: true, name: true } } } as const;

/** GET /api/v1/team — members, and pending invitations for those who can manage them. */
teamRouter.get("/team", requireAuth, route(async (request, response) => {
  const user = request.user!;
  const members = await prisma.organizationMembership.findMany({ where: { organizationId: user.organizationId }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } });
  const invitations = isManager(user.role)
    ? await prisma.invitation.findMany({ where: { organizationId: user.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: inviteSelect, orderBy: { createdAt: "desc" } })
    : [];
  return response.json({ data: { members: members.map(member => ({ id: member.id, user: member.user, role: member.role, team: member.team, joinedAt: member.createdAt })), invitations, canManage: isManager(user.role) } });
}));

const memberSchema = z.object({ role: z.enum(roles).optional(), team: z.enum(teams).optional() }).strict();

/** PATCH /api/v1/team/members/:id — change a member's role or team. Owners and admins only. */
teamRouter.patch("/team/members/:id", requireAuth, route(async (request, response) => {
  const user = request.user!;
  if (!isManager(user.role)) return forbidden(response, "Only workspace owners and admins can change members.");
  const input = memberSchema.parse(request.body ?? {});
  const member = await prisma.organizationMembership.findFirst({ where: { id: request.params.id, organizationId: user.organizationId } });
  if (!member) return notFound(response, "Member not found");
  // Owner is the one role an admin cannot hand out or take away.
  if ((input.role === "OWNER" || member.role === "OWNER") && input.role !== undefined && input.role !== member.role && user.role !== "OWNER") return forbidden(response, "Only an owner can grant or remove the owner role.");
  if (member.role === "OWNER" && input.role && input.role !== "OWNER") {
    const owners = await prisma.organizationMembership.count({ where: { organizationId: user.organizationId, role: "OWNER" } });
    if (owners <= 1) return conflict(response, "LAST_OWNER", "A workspace must keep at least one owner.");
  }
  const updated = await prisma.organizationMembership.update({ where: { id: member.id }, data: input, include: { user: { select: { id: true, name: true, email: true } } } });
  return response.json({ data: { id: updated.id, user: updated.user, role: updated.role, team: updated.team, joinedAt: updated.createdAt } });
}));

/**
 * DELETE /api/v1/team/members/:id — removes someone from the workspace. Their open bugs go back to
 * NEW, unassigned, with a history entry, so nothing silently stays with a person who has left.
 */
teamRouter.delete("/team/members/:id", requireAuth, route(async (request, response) => {
  const user = request.user!;
  if (!isManager(user.role)) return forbidden(response, "Only workspace owners and admins can remove members.");
  const member = await prisma.organizationMembership.findFirst({ where: { id: request.params.id, organizationId: user.organizationId } });
  if (!member) return notFound(response, "Member not found");
  if (member.role === "OWNER" && user.role !== "OWNER") return forbidden(response, "Only an owner can remove an owner.");
  if (member.role === "OWNER" && (await prisma.organizationMembership.count({ where: { organizationId: user.organizationId, role: "OWNER" } })) <= 1) return conflict(response, "LAST_OWNER", "A workspace must keep at least one owner.");

  await prisma.$transaction(async tx => {
    const open = await tx.bug.findMany({ where: { assigneeId: member.userId, project: { organizationId: user.organizationId }, status: { notIn: [...doneStatuses] } }, select: { id: true, status: true } });
    for (const bug of open) {
      await tx.bug.update({ where: { id: bug.id }, data: { assigneeId: null, status: "NEW" } });
      await tx.bugEvent.create({ data: { bugId: bug.id, actorId: user.id, type: "UNASSIGNED", fromValue: member.userId, note: "Assignee was removed from the workspace" } });
      if (bug.status !== "NEW") await tx.bugEvent.create({ data: { bugId: bug.id, actorId: user.id, type: "STATUS_CHANGED", fromValue: bug.status, toValue: "NEW", note: "Assignee was removed from the workspace" } });
    }
    await tx.notification.deleteMany({ where: { userId: member.userId, organizationId: user.organizationId } });
    await tx.organizationMembership.delete({ where: { id: member.id } });
  });
  return response.status(204).send();
}));

const inviteSchema = z.object({ email: z.string().email().max(254), role: z.enum(roles).default("MEMBER"), team: z.enum(teams).default("DEVELOPER") });

/** POST /api/v1/invitations — creates a one-time link. The link is in this response and nowhere else. */
teamRouter.post("/invitations", requireAuth, route(async (request, response) => {
  const user = request.user!;
  if (!isManager(user.role)) return forbidden(response, "Only workspace owners and admins can invite people.");
  const input = inviteSchema.parse(request.body ?? {});
  if (input.role === "OWNER" && user.role !== "OWNER") return forbidden(response, "Only an owner can invite another owner.");
  const email = input.email.toLowerCase();
  if (await prisma.organizationMembership.findFirst({ where: { organizationId: user.organizationId, user: { email } } })) return conflict(response, "ALREADY_MEMBER", "That person is already a member of this workspace.");

  const token = crypto.randomBytes(32).toString("base64url");
  const [, invitation] = await prisma.$transaction([
    // A new invitation replaces any earlier unused one for the same address.
    prisma.invitation.updateMany({ where: { organizationId: user.organizationId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.invitation.create({ data: { organizationId: user.organizationId, email, role: input.role, team: input.team, tokenHash: hashToken(token), invitedById: user.id, expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) }, select: inviteSelect }),
  ]);
  return response.status(201).json({ data: { ...invitation, inviteUrl: `${config.FRONTEND_URL}/invite/${token}` } });
}));

/** DELETE /api/v1/invitations/:id — revokes an unused invitation. */
teamRouter.delete("/invitations/:id", requireAuth, route(async (request, response) => {
  const user = request.user!;
  if (!isManager(user.role)) return forbidden(response, "Only workspace owners and admins can revoke invitations.");
  const { count } = await prisma.invitation.updateMany({ where: { id: request.params.id, organizationId: user.organizationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!count) return notFound(response, "Invitation not found");
  return response.status(204).send();
}));

/* ------------------------------------------------------------------------------------------------
 * Accepting - public, because the invitee has no account yet
 * ---------------------------------------------------------------------------------------------- */

const acceptLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true });
const tokenSchema = z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/);

/** Every unusable invitation looks the same, so the endpoint does not reveal which links ever existed. */
async function usableInvitation(token: string) {
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { organization: { select: { id: true, name: true } }, invitedBy: { select: { name: true } } } });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt.getTime() < Date.now()) return null;
  return invitation;
}

const invalidInvite = (response: Response) => fail(response, 404, "INVITE_INVALID", "This invitation link is invalid, has expired, or has already been used. Ask for a new one.");

/** GET /api/v1/invitations/lookup/:token — what the invite page shows before the person accepts. */
teamRouter.get("/invitations/lookup/:token", acceptLimit, route(async (request, response) => {
  const parsed = tokenSchema.safeParse(request.params.token);
  const invitation = parsed.success ? await usableInvitation(parsed.data) : null;
  if (!invitation) return invalidInvite(response);
  return response.json({ data: { organizationName: invitation.organization.name, email: invitation.email, role: invitation.role, team: invitation.team, invitedBy: invitation.invitedBy?.name ?? null, expiresAt: invitation.expiresAt } });
}));

const acceptSchema = z.object({ token: tokenSchema, name: signupSchema.shape.name, password: signupSchema.shape.password });

/**
 * POST /api/v1/invitations/accept — creates the invitee's account with the invited role and team and
 * signs them in. The email comes from the invitation, never from the request.
 */
teamRouter.post("/invitations/accept", acceptLimit, route(async (request, response) => {
  const input = acceptSchema.parse(request.body ?? {});
  const invitation = await usableInvitation(input.token);
  if (!invitation) return invalidInvite(response);
  if (await prisma.user.findUnique({ where: { email: invitation.email } })) {
    return conflict(response, "ACCOUNT_EXISTS", "This email already has a Testloop account, and an account can belong to one workspace. Ask the person who invited you to use a different email address.");
  }
  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await prisma.$transaction(async tx => {
    // Claimed atomically, so one link cannot create two accounts.
    const claimed = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
    if (!claimed.count) return null;
    return tx.user.create({ data: { email: invitation.email, name: input.name, passwordHash, memberships: { create: { organizationId: invitation.organizationId, role: invitation.role, team: invitation.team } } } });
  });
  if (!user) return invalidInvite(response);
  sessionCookie(response, createSession(user.id, invitation.organizationId));
  return response.status(201).json({ data: { user: { id: user.id, email: user.email, name: user.name }, organizationId: invitation.organizationId } });
}));

/* ------------------------------------------------------------------------------------------------
 * Notifications
 * ---------------------------------------------------------------------------------------------- */

/** GET /api/v1/notifications — newest first, with the unread count for the bell. */
teamRouter.get("/notifications", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  const scope = { userId: user.id, organizationId: user.organizationId };
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where: scope, orderBy: { createdAt: "desc" }, take: 30, include: { actor: { select: { name: true } }, bug: { select: { id: true, reference: true } } } }),
    prisma.notification.count({ where: { ...scope, readAt: null } }),
  ]);
  return response.json({ data: { items, unreadCount } });
}));

teamRouter.post("/notifications/read-all", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  const { count } = await prisma.notification.updateMany({ where: { userId: user.id, organizationId: user.organizationId, readAt: null }, data: { readAt: new Date() } });
  return response.json({ data: { updated: count } });
}));

teamRouter.post("/notifications/:id/read", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  const { count } = await prisma.notification.updateMany({ where: { id: request.params.id, userId: user.id, organizationId: user.organizationId }, data: { readAt: new Date() } });
  if (!count) return notFound(response, "Notification not found");
  return response.json({ data: { id: request.params.id, read: true } });
}));
