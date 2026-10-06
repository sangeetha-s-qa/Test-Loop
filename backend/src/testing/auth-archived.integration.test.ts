import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { mailCount, startMailSink } from "./mail-sink";

/**
 * The default configuration: emailed codes archived. Sign-up and sign-in behave exactly as they did
 * before codes existed, nothing is emailed, and the code-only endpoints are not reachable.
 *
 * `setup-env.ts` switches the feature on for every other suite, so this file turns it off again
 * before importing the app; config is parsed at import time, once per test file.
 */
process.env.AUTH_EMAIL_OTP_ENABLED = "false";

const cookieOf = (response: request.Response) => {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.find(value => value.startsWith("qa_session=") && !value.startsWith("qa_session=;"))?.split(";")[0] ?? null;
};

describe("email codes archived (default)", () => {
  let app: Express;
  let prisma: typeof import("../db").prisma;
  const email = `archived-${crypto.randomUUID().slice(0, 8)}@integration.test`;
  const password = "archived-mode-password-123";

  beforeAll(async () => {
    ({ app } = await import("../server"));
    ({ prisma } = await import("../db"));
    await startMailSink().ready;
  });

  afterAll(async () => {
    const user = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
    if (user) await prisma.organization.deleteMany({ where: { id: { in: user.memberships.map(item => item.organizationId) } } });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it("reports the feature as off", async () => {
    const response = await request(app).get("/api/v1/auth/email-status").expect(200);
    expect(response.body.data.otpEnabled).toBe(false);
  });

  it("signs up straight into a session without emailing anything", async () => {
    const response = await request(app).post("/api/v1/auth/signup").send({ email, name: "Archived Mode", password, organizationName: "Archived org" }).expect(201);
    expect(response.body.data.user.email).toBe(email);
    expect(response.body.data.otpRequired).toBeUndefined();
    const cookie = cookieOf(response);
    expect(cookie).not.toBeNull();
    await request(app).get("/api/v1/auth/me").set("Cookie", cookie!).expect(200);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(mailCount(email)).toBe(0);
  });

  it("signs in with email and password alone", async () => {
    await request(app).post("/api/v1/auth/login").send({ email, password: "not-the-password-at-all" }).expect(401);
    const response = await request(app).post("/api/v1/auth/login").send({ email, password }).expect(200);
    expect(response.body.data.organizationId).toEqual(expect.any(String));
    await request(app).get("/api/v1/auth/me").set("Cookie", cookieOf(response)!).expect(200);
    expect(mailCount(email)).toBe(0);
    expect(await prisma.emailOtp.count({ where: { user: { email } } })).toBe(0);
  });

  it("hides every code and password-reset endpoint", async () => {
    const challengeId = crypto.randomUUID();
    for (const [path, body] of [
      ["/api/v1/auth/otp/verify", { challengeId, code: "123456" }],
      ["/api/v1/auth/otp/resend", { challengeId }],
      ["/api/v1/auth/forgot-password", { email }],
      ["/api/v1/auth/reset-password", { challengeId, code: "123456", password: "new-password-123456" }],
    ] as const) {
      const response = await request(app).post(path).send(body);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code).toBe("FEATURE_DISABLED");
    }
    expect(mailCount(email)).toBe(0);
  });
});
