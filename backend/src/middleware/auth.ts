import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db";
import { config } from "../config";

export type AuthRequest = Request<Record<string, string>> & { user?: { id: string; organizationId: string; role: string; team: string } };

function sign(value: string) {
  return crypto.createHmac("sha256", config.SESSION_SECRET).update(value).digest("hex");
}

export function createSession(userId: string, organizationId: string) {
  // `issuedAt` lets a password change revoke every session that existed before it.
  const payload = Buffer.from(JSON.stringify({ userId, organizationId, issuedAt: Date.now(), expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readSession(value: string) {
  const [payload, signature] = value.split(".");
  if (!payload || !signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return null;
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { userId: string; organizationId: string; issuedAt?: number; expiresAt: number };
  return parsed.expiresAt > Date.now() ? parsed : null;
}

export async function requireAuth(request: AuthRequest, response: Response, next: NextFunction) {
  try {
    const session = request.cookies?.qa_session ? readSession(request.cookies.qa_session) : null;
    if (!session) return response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
    const membership = await prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId: session.userId, organizationId: session.organizationId } }, include: { user: { select: { passwordChangedAt: true } } } });
    if (!membership) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Organization membership required" } });
    // A session older than the last password change belongs to whoever had the old password.
    const changedAt = membership.user.passwordChangedAt?.getTime();
    if (changedAt && (!session.issuedAt || session.issuedAt < changedAt)) return response.status(401).json({ error: { code: "SESSION_REVOKED", message: "Your password was changed. Please sign in again." } });
    request.user = { id: session.userId, organizationId: session.organizationId, role: membership.role, team: membership.team };
    next();
  } catch { response.status(401).json({ error: { code: "INVALID_SESSION", message: "Invalid session" } }); }
}

export function canManageProjects(role: string) { return role === "OWNER" || role === "ADMIN" || role === "MEMBER"; }