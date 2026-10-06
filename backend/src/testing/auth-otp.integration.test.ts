import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../server";
import { prisma } from "../db";
import { cleanUpOrganization, databaseReachable } from "./harness";
import { mailCount, startMailSink, waitForMail, waitForOtp } from "./mail-sink";

/**
 * Sign-up verification, two-step sign-in, and password reset against the real API, the real
 * database, and a real SMTP server. Every code used here was read out of an email that was sent.
 */

const password = "otp-integration-password-123";
const cookieOf = (response: request.Response) => {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.find(value => value.startsWith("qa_session=") && !value.startsWith("qa_session=;"))?.split(";")[0] ?? null;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("email OTP authentication", () => {
  const email = `otp-${crypto.randomUUID().slice(0, 8)}@integration.test`;
  let organizationId: string;
  let userId: string;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    await startMailSink().ready;
  });

  afterAll(async () => {
    if (organizationId) await cleanUpOrganization(organizationId);
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it("reports that email delivery is configured", async () => {
    const response = await request(app).get("/api/v1/auth/email-status").expect(200);
    expect(response.body.data.configured).toBe(true);
  });

  /* ---------------------------------------------------------------- sign up */

  it("signs up without a session until the emailed code is entered", async () => {
    const since = Date.now();
    const started = await request(app).post("/api/v1/auth/signup").send({ email, name: "Otp Tester", password, organizationName: "Otp org" }).expect(201);
    expect(cookieOf(started)).toBeNull();
    expect(started.body.data).toMatchObject({ otpRequired: true, email: expect.stringMatching(/^o\*+@integration\.test$/), expiresInSeconds: 600 });

    const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
    userId = user.id;
    organizationId = user.memberships[0].organizationId;
    expect(user.emailVerifiedAt).toBeNull();

    const mail = await waitForMail(email, since);
    expect(mail.raw).toContain("Verify your email for Testloop");
    const code = await waitForOtp(email, since);

    // The code is never stored, only an HMAC of it.
    const stored = await prisma.emailOtp.findUniqueOrThrow({ where: { id: started.body.data.challengeId } });
    expect(stored.codeHash).not.toContain(code);
    expect(stored.purpose).toBe("SIGNUP_VERIFICATION");

    const wrong = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: started.body.data.challengeId, code: code === "000000" ? "111111" : "000000" }).expect(400);
    expect(wrong.body.error).toMatchObject({ code: "OTP_INVALID", details: { attemptsRemaining: 4 } });

    const verified = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: started.body.data.challengeId, code }).expect(200);
    const cookie = cookieOf(verified);
    expect(cookie).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt).not.toBeNull();
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", cookie!).expect(200);
    expect(me.body.data.user.email).toBe(email);

    // Single use.
    const reused = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: started.body.data.challengeId, code }).expect(400);
    expect(reused.body.error.code).toBe("OTP_INVALID");
  });

  it("refuses a second account for the same email and rejects malformed codes", async () => {
    await request(app).post("/api/v1/auth/signup").send({ email, name: "Otp Tester", password, organizationName: "Otp org" }).expect(409);
    await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: crypto.randomUUID(), code: "12ab56" }).expect(400);
    const unknown = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: crypto.randomUUID(), code: "123456" }).expect(400);
    expect(unknown.body.error.code).toBe("OTP_INVALID");
  });

  /* ---------------------------------------------------------------- sign in */

  it("requires the emailed code on every sign-in; a password alone sets no session", async () => {
    const before = mailCount(email);
    const badPassword = await request(app).post("/api/v1/auth/login").send({ email, password: "wrong-password-entirely" }).expect(401);
    expect(badPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(mailCount(email)).toBe(before);

    const since = Date.now();
    const step1 = await request(app).post("/api/v1/auth/login").send({ email: email.toUpperCase(), password }).expect(200);
    expect(cookieOf(step1)).toBeNull();
    expect(step1.body.data.otpRequired).toBe(true);
    const mail = await waitForMail(email, since);
    expect(mail.raw).toContain("Your Testloop sign-in code");

    const step2 = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: step1.body.data.challengeId, code: await waitForOtp(email, since) }).expect(200);
    expect(cookieOf(step2)).not.toBeNull();
  });

  it("locks a code after five wrong guesses, even if the right one comes next", async () => {
    const since = Date.now();
    const step1 = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
    const code = await waitForOtp(email, since);
    const wrong = code === "999999" ? "999998" : "999999";
    for (let attempt = 1; attempt <= 4; attempt += 1) await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: step1.body.data.challengeId, code: wrong }).expect(400);
    const locked = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: step1.body.data.challengeId, code: wrong }).expect(429);
    expect(locked.body.error.code).toBe("OTP_LOCKED");
    const tooLate = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: step1.body.data.challengeId, code });
    expect(tooLate.status).not.toBe(200);
    expect(cookieOf(tooLate)).toBeNull();
  });

  it("rejects an expired code", async () => {
    const since = Date.now();
    const step1 = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
    const code = await waitForOtp(email, since);
    await prisma.emailOtp.update({ where: { id: step1.body.data.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: step1.body.data.challengeId, code }).expect(400);
    expect(expired.body.error.code).toBe("OTP_EXPIRED");
  });

  it("resends only after the cooldown, and the replaced code stops working", async () => {
    const since = Date.now();
    const step1 = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
    const firstCode = await waitForOtp(email, since);

    const tooSoon = await request(app).post("/api/v1/auth/otp/resend").send({ challengeId: step1.body.data.challengeId }).expect(429);
    expect(tooSoon.body.error).toMatchObject({ code: "OTP_RESEND_TOO_SOON", details: { retryAfterSeconds: expect.any(Number) } });

    await sleep(2100);
    const resentAt = Date.now();
    const resent = await request(app).post("/api/v1/auth/otp/resend").send({ challengeId: step1.body.data.challengeId }).expect(200);
    expect(resent.body.data.challengeId).not.toBe(step1.body.data.challengeId);
    const secondCode = await waitForOtp(email, resentAt);

    await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: step1.body.data.challengeId, code: firstCode }).expect(400);
    await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: resent.body.data.challengeId, code: secondCode }).expect(200);
  });

  /* ---------------------------------------------------------------- forgot password */

  it("answers forgot-password identically for unknown addresses and sends them nothing", async () => {
    const stranger = `nobody-${crypto.randomUUID().slice(0, 8)}@integration.test`;
    const response = await request(app).post("/api/v1/auth/forgot-password").send({ email: stranger }).expect(200);
    expect(Object.keys(response.body.data).sort()).toEqual(["challengeId", "email", "expiresInSeconds", "otpRequired", "resendAfterSeconds"]);
    await sleep(300);
    expect(mailCount(stranger)).toBe(0);
    // Its challenge behaves like any wrong code, revealing nothing.
    const verify = await request(app).post("/api/v1/auth/reset-password").send({ challengeId: response.body.data.challengeId, code: "123456", password: "a-brand-new-password-1" }).expect(400);
    expect(verify.body.error.code).toBe("OTP_INVALID");
  });

  it("resets the password with the emailed code and signs out every existing session", async () => {
    const loginSince = Date.now();
    const step1 = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
    const signedIn = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: step1.body.data.challengeId, code: await waitForOtp(email, loginSince) }).expect(200);
    const oldCookie = cookieOf(signedIn)!;
    await request(app).get("/api/v1/auth/me").set("Cookie", oldCookie).expect(200);

    await sleep(5);
    const since = Date.now();
    const forgot = await request(app).post("/api/v1/auth/forgot-password").send({ email }).expect(200);
    const mail = await waitForMail(email, since);
    expect(mail.raw).toContain("Reset your Testloop password");
    const code = await waitForOtp(email, since);

    // A reset code cannot be used to sign in, and a sign-in code cannot reset a password.
    await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: forgot.body.data.challengeId, code }).expect(400);
    await request(app).post("/api/v1/auth/reset-password").send({ challengeId: forgot.body.data.challengeId, code, password: "short" }).expect(400);

    const newPassword = "a-brand-new-password-456";
    const noticeSince = Date.now();
    await request(app).post("/api/v1/auth/reset-password").send({ challengeId: forgot.body.data.challengeId, code, password: newPassword }).expect(200);
    expect((await waitForMail(email, noticeSince)).raw).toContain("Your Testloop password was changed");

    const revoked = await request(app).get("/api/v1/auth/me").set("Cookie", oldCookie).expect(401);
    expect(revoked.body.error.code).toBe("SESSION_REVOKED");
    await request(app).post("/api/v1/auth/login").send({ email, password }).expect(401);

    const again = Date.now();
    const relogin = await request(app).post("/api/v1/auth/login").send({ email, password: newPassword }).expect(200);
    const fresh = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: relogin.body.data.challengeId, code: await waitForOtp(email, again) }).expect(200);
    await request(app).get("/api/v1/auth/me").set("Cookie", cookieOf(fresh)!).expect(200);
  });

  it("caps how many codes one account can be sent per hour", async () => {
    const recent = await prisma.emailOtp.count({ where: { userId, purpose: "SIGN_IN", createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
    // Fill the hour's allowance directly, then confirm the next request is refused without sending.
    await prisma.emailOtp.createMany({ data: Array.from({ length: Math.max(0, 8 - recent) }, () => ({ userId, purpose: "SIGN_IN" as const, codeHash: "x", expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date() })) });
    const before = mailCount(email);
    const limited = await request(app).post("/api/v1/auth/login").send({ email, password: "a-brand-new-password-456" }).expect(429);
    expect(limited.body.error.code).toBe("OTP_RATE_LIMITED");
    expect(mailCount(email)).toBe(before);
  });
});
