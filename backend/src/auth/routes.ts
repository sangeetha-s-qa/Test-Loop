import crypto from "node:crypto";
import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { fail, route } from "../http";
import { createSession, requireAuth, type AuthRequest } from "../middleware/auth";
import { loginSchema, signupSchema } from "../validation";
import { EmailError, emailConfigured, passwordChangedEmail, sendEmail } from "./mailer";
import { OtpError, challengeResponse, issueOtp, resendOtp, verifyOtp } from "./otp";

/**
 * Authentication with emailed one-time codes.
 *
 *   sign up  -> code to verify the address      -> POST /auth/otp/verify     -> session
 *   sign in  -> password, then a code every time -> POST /auth/otp/verify     -> session
 *   forgot   -> code                              -> POST /auth/reset-password -> sign in again
 *
 * No step before the code sets a session cookie, so a password alone never signs anyone in.
 *
 * ARCHIVED BY DEFAULT: unless AUTH_EMAIL_OTP_ENABLED=true, sign-up and sign-in set the session
 * straight away (the behaviour before codes existed) and every code-only endpoint answers 404.
 * Nothing here is deleted, so switching the flag back on restores the whole flow.
 */

export const emailOtpEnabled = () => config.AUTH_EMAIL_OTP_ENABLED === "true";

export const authRouter = Router();

/**
 * Brute-force protection on every endpoint that takes a password or a code, or sends an email.
 * `me` and `logout` stay outside it: the shell checks the session on every page load, and putting
 * those on this budget once signed users out just for navigating around.
 */
// One counter per endpoint, so completing a sign-in (password, then code) costs each budget once.
for (const path of ["/auth/login", "/auth/signup", "/auth/otp/verify", "/auth/otp/resend", "/auth/forgot-password", "/auth/reset-password"]) {
  authRouter.use(path, rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true }));
}

/** While archived, the code-only endpoints do not exist as far as a client can tell. */
const archivedPaths = ["/auth/otp/verify", "/auth/otp/resend", "/auth/forgot-password", "/auth/reset-password"];
authRouter.use(archivedPaths, (_request, response, next) => (emailOtpEnabled() ? next() : fail(response, 404, "FEATURE_DISABLED", "Email codes and password reset are not enabled on this server.")));

const sessionCookie = (response: Response, token: string) => response.cookie("qa_session", token, { httpOnly: true, secure: config.NODE_ENV === "production", sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });

const challengeSchema = z.object({ challengeId: z.string().uuid() });
const verifySchema = challengeSchema.extend({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });
const forgotSchema = z.object({ email: z.string().email().max(254) });
const resetSchema = verifySchema.extend({ password: signupSchema.shape.password });

/** Maps the auth layer's own failures to responses; anything else goes to the global handler. */
const handled = (response: Response, error: unknown) => {
  if (error instanceof OtpError) return response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
  if (error instanceof EmailError) return fail(response, 503, error.code, error.code === "EMAIL_NOT_CONFIGURED" ? "Email delivery is not configured on this server, so a verification code cannot be sent. Ask your administrator to set the SMTP settings." : error.message);
  throw error;
};

const notConfigured = (response: Response) => handled(response, new EmailError("EMAIL_NOT_CONFIGURED", ""));

/** POST /auth/signup — creates the account unverified and emails a code. No session yet. */
authRouter.post("/auth/signup", route(async (request, response) => {
  const input = signupSchema.parse(request.body);
  if (emailOtpEnabled() && !emailConfigured()) return notConfigured(response);
  const email = input.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) return fail(response, 409, "EMAIL_EXISTS", "An account already exists for that email");
  const user = await prisma.user.create({ data: { email, name: input.name, passwordHash: await bcrypt.hash(input.password, 12), memberships: { create: { role: "OWNER", organization: { create: { name: input.organizationName } } } } }, include: { memberships: true } });
  if (!emailOtpEnabled()) {
    const membership = user.memberships[0];
    sessionCookie(response, createSession(user.id, membership.organizationId));
    return response.status(201).json({ data: { user: { id: user.id, email: user.email, name: user.name }, organizationId: membership.organizationId } });
  }
  try {
    const challengeId = await issueOtp(user, "SIGNUP_VERIFICATION");
    return response.status(201).json({ data: challengeResponse(challengeId, email) });
  } catch (error) {
    // The address could not be reached, so the account would be one nobody can ever verify. Undo
    // it, so the same email can simply sign up again once mail works.
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: user.memberships[0].organizationId } }).catch(() => undefined);
    return handled(response, error);
  }
}));

/** POST /auth/login — checks the password, then emails a code. No session until the code is entered. */
authRouter.post("/auth/login", route(async (request, response) => {
  const input = loginSchema.parse(request.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() }, include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 } } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash)) || !user.memberships[0]) return fail(response, 401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  if (!emailOtpEnabled()) {
    sessionCookie(response, createSession(user.id, user.memberships[0].organizationId));
    return response.json({ data: { user: { id: user.id, email: user.email, name: user.name }, organizationId: user.memberships[0].organizationId } });
  }
  try {
    return response.json({ data: challengeResponse(await issueOtp(user, "SIGN_IN"), user.email) });
  } catch (error) {
    return handled(response, error);
  }
}));

/**
 * POST /auth/otp/verify — completes sign-up or sign-in. Entering a code that was emailed to the
 * address also proves the address, so it marks the email verified either way.
 */
authRouter.post("/auth/otp/verify", route(async (request, response) => {
  const input = verifySchema.parse(request.body);
  try {
    const { user } = await verifyOtp(input.challengeId, input.code, ["SIGNUP_VERIFICATION", "SIGN_IN"]);
    if (!user.emailVerifiedAt) await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const membership = await prisma.organizationMembership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    if (!membership) return fail(response, 403, "FORBIDDEN", "Organization membership required");
    sessionCookie(response, createSession(user.id, membership.organizationId));
    return response.json({ data: { user: { id: user.id, email: user.email, name: user.name }, organizationId: membership.organizationId } });
  } catch (error) {
    return handled(response, error);
  }
}));

/** POST /auth/otp/resend — a new code for the same step, after the cooldown. */
authRouter.post("/auth/otp/resend", route(async (request, response) => {
  const input = challengeSchema.parse(request.body);
  if (!emailConfigured()) return notConfigured(response);
  try {
    const resent = await resendOtp(input.challengeId);
    return response.json({ data: { ...challengeResponse(resent.challengeId, resent.email ?? "unknown@unknown"), ...(resent.email ? {} : { email: null }) } });
  } catch (error) {
    return handled(response, error);
  }
}));

/**
 * POST /auth/forgot-password — always the same answer, whether or not the address has an account,
 * so this cannot be used to discover who is registered. A real code is sent only when it does.
 */
authRouter.post("/auth/forgot-password", route(async (request, response) => {
  const input = forgotSchema.parse(request.body);
  if (!emailConfigured()) return notConfigured(response);
  const email = input.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  let challengeId: string = crypto.randomUUID();
  if (user) {
    try {
      challengeId = await issueOtp(user, "PASSWORD_RESET");
    } catch (error) {
      // Reporting the failure would reveal that the account exists; the person can request again.
      console.error(JSON.stringify({ event: "auth.reset_code_failed", code: error instanceof Error ? error.name : "UNKNOWN" }));
    }
  }
  return response.json({ data: challengeResponse(challengeId, email) });
}));

/** POST /auth/reset-password — code plus new password. Signs out every existing session. */
authRouter.post("/auth/reset-password", route(async (request, response) => {
  const input = resetSchema.parse(request.body);
  try {
    const { user } = await verifyOtp(input.challengeId, input.code, ["PASSWORD_RESET"]);
    const now = new Date();
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(input.password, 12), passwordChangedAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now } }),
      // Any other code still open for this account is now pointless at best.
      prisma.emailOtp.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: now } }),
    ]);
    // Best effort: the reset already happened, and a notice that fails to send must not undo it.
    await sendEmail({ to: user.email, ...passwordChangedEmail(user.name) }).catch(() => undefined);
    response.clearCookie("qa_session");
    return response.json({ data: { reset: true } });
  } catch (error) {
    return handled(response, error);
  }
}));

authRouter.post("/auth/logout", (_request, response) => response.clearCookie("qa_session").status(204).send());

authRouter.get("/auth/me", requireAuth, route(async (request: AuthRequest, response) => {
  const user = await prisma.user.findUnique({ where: { id: request.user!.id }, select: { id: true, email: true, name: true, emailVerifiedAt: true } });
  return response.json({ data: { user, organizationId: request.user!.organizationId, role: request.user!.role, team: request.user!.team } });
}));

/** GET /auth/email-status — lets the sign-in pages say up front that codes cannot be sent. */
authRouter.get("/auth/email-status", (_request, response) => response.json({ data: { otpEnabled: emailOtpEnabled(), configured: emailConfigured() } }));
