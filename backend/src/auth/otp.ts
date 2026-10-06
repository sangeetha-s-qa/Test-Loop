import crypto from "node:crypto";
import type { EmailOtpPurpose } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { otpEmail, sendEmail } from "./mailer";

/**
 * Emailed one-time codes.
 *
 * A code is six random digits, stored only as an HMAC bound to its own challenge id, valid for
 * OTP_TTL_SECONDS, usable once, and locked after OTP_MAX_ATTEMPTS wrong guesses. The challenge id is
 * what the browser holds between steps; on its own it proves nothing.
 */

export class OtpError extends Error {
  constructor(
    public readonly code: "OTP_INVALID" | "OTP_EXPIRED" | "OTP_LOCKED" | "OTP_RESEND_TOO_SOON" | "OTP_RATE_LIMITED",
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OtpError";
  }
}

const hashCode = (challengeId: string, code: string) => crypto.createHmac("sha256", config.SESSION_SECRET).update(`otp:${challengeId}:${code}`).digest("hex");

const sameHash = (a: string, b: string) => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/** `dev@techinorm.com` -> `d**@techinorm.com`: enough to recognise, not enough to harvest. */
export const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
};

/** What every "a code was sent" response carries, so the client can show a countdown honestly. */
export const challengeResponse = (challengeId: string, email: string) => ({
  otpRequired: true as const,
  challengeId,
  email: maskEmail(email),
  expiresInSeconds: config.OTP_TTL_SECONDS,
  resendAfterSeconds: config.OTP_RESEND_COOLDOWN_SECONDS,
});

/** Creates a code, emails it, and returns the challenge id. Earlier open codes for the same purpose stop working. */
export async function issueOtp(user: { id: string; email: string; name: string }, purpose: EmailOtpPurpose) {
  const sentLastHour = await prisma.emailOtp.count({ where: { userId: user.id, purpose, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
  if (sentLastHour >= config.OTP_MAX_PER_HOUR) throw new OtpError("OTP_RATE_LIMITED", "Too many codes were requested. Please wait an hour and try again.", 429);

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const id = crypto.randomUUID();
  await prisma.$transaction([
    prisma.emailOtp.updateMany({ where: { userId: user.id, purpose, consumedAt: null }, data: { consumedAt: new Date() } }),
    prisma.emailOtp.create({ data: { id, userId: user.id, purpose, codeHash: hashCode(id, code), expiresAt: new Date(Date.now() + config.OTP_TTL_SECONDS * 1000) } }),
  ]);
  try {
    await sendEmail({ to: user.email, ...otpEmail(purpose, user.name, code, Math.round(config.OTP_TTL_SECONDS / 60)) });
  } catch (error) {
    // A code that never left the server must not stay usable or count against anything.
    await prisma.emailOtp.delete({ where: { id } }).catch(() => undefined);
    throw error;
  }
  return id;
}

/**
 * Checks a code and, on success, consumes it. Every failure path is decided by an atomic update, so
 * two parallel guesses cannot both slip under the attempt limit.
 */
export async function verifyOtp(challengeId: string, code: string, purposes: EmailOtpPurpose[]) {
  const otp = await prisma.emailOtp.findUnique({ where: { id: challengeId }, include: { user: { select: { id: true, email: true, name: true, emailVerifiedAt: true } } } });
  if (!otp || !purposes.includes(otp.purpose) || otp.consumedAt) throw new OtpError("OTP_INVALID", "This code is no longer valid. Request a new one.", 400);
  if (otp.expiresAt.getTime() < Date.now()) throw new OtpError("OTP_EXPIRED", "This code has expired. Request a new one.", 400);

  const counted = await prisma.emailOtp.updateMany({ where: { id: otp.id, consumedAt: null, attempts: { lt: config.OTP_MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
  if (!counted.count) throw new OtpError("OTP_LOCKED", "Too many incorrect attempts. Request a new code.", 429);

  if (!sameHash(otp.codeHash, hashCode(otp.id, code))) {
    const used = otp.attempts + 1;
    if (used >= config.OTP_MAX_ATTEMPTS) {
      await prisma.emailOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
      throw new OtpError("OTP_LOCKED", "Too many incorrect attempts. Request a new code.", 429);
    }
    throw new OtpError("OTP_INVALID", "That code is incorrect.", 400, { attemptsRemaining: config.OTP_MAX_ATTEMPTS - used });
  }

  const consumed = await prisma.emailOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (!consumed.count) throw new OtpError("OTP_INVALID", "This code is no longer valid. Request a new one.", 400);
  return { purpose: otp.purpose, user: otp.user };
}

/**
 * Sends a fresh code for an existing challenge. Unknown ids get a convincing new id back rather than
 * an error, so this endpoint cannot be used to learn which password-reset requests were real.
 */
export async function resendOtp(challengeId: string) {
  const otp = await prisma.emailOtp.findUnique({ where: { id: challengeId }, include: { user: { select: { id: true, email: true, name: true } } } });
  if (!otp) return { challengeId: crypto.randomUUID(), email: null };
  const waited = (Date.now() - otp.createdAt.getTime()) / 1000;
  if (waited < config.OTP_RESEND_COOLDOWN_SECONDS) {
    const retryAfterSeconds = Math.ceil(config.OTP_RESEND_COOLDOWN_SECONDS - waited);
    throw new OtpError("OTP_RESEND_TOO_SOON", `Please wait ${retryAfterSeconds} seconds before requesting another code.`, 429, { retryAfterSeconds });
  }
  return { challengeId: await issueOtp(otp.user, otp.purpose), email: otp.user.email };
}
