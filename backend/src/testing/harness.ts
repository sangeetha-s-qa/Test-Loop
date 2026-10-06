import crypto from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { prisma } from "../db";
import { startMailSink, waitForOtp } from "./mail-sink";

/**
 * Helpers shared by the integration tests. Everything here talks to the real API, the real
 * database, and the real queue: nothing is stubbed, so a passing integration test means the
 * behaviour actually works end to end.
 */

export type Agent = {
  organizationId: string;
  userId: string;
  email: string;
  cookie: string;
  get: (path: string) => request.Test;
  post: (path: string, body?: object) => request.Test;
  patch: (path: string, body: object) => request.Test;
  delete: (path: string) => request.Test;
};

/**
 * Creates a fresh user in a fresh organization and returns an authenticated request agent.
 *
 * Goes through the real sign-up: the verification code is emailed over SMTP to the test mail sink
 * and read back from there, exactly as a person would read it from their inbox.
 */
export async function signUp(app: Express, label: string): Promise<Agent> {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@integration.test`;
  await startMailSink().ready;
  const since = Date.now();
  const started = await request(app)
    .post("/api/v1/auth/signup")
    .send({ email, name: `${label} tester`, password: "integration-test-password-123", organizationName: `${label} org` })
    .expect(201);
  const code = await waitForOtp(email, since);
  const response = await request(app).post("/api/v1/auth/otp/verify").send({ challengeId: started.body.data.challengeId, code }).expect(200);

  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.find(value => value.startsWith("qa_session="))?.split(";")[0];
  if (!cookie) throw new Error("Signup did not set a session cookie");

  return {
    organizationId: response.body.data.organizationId,
    userId: response.body.data.user.id,
    email,
    cookie,
    get: path => request(app).get(path).set("Cookie", cookie),
    post: (path, body) => (body === undefined ? request(app).post(path).set("Cookie", cookie) : request(app).post(path).set("Cookie", cookie).send(body as object)),
    patch: (path, body) => request(app).patch(path).set("Cookie", cookie).send(body as object),
    delete: path => request(app).delete(path).set("Cookie", cookie),
  };
}

export const defaultAdvancedSettings = {
  browser: "chromium" as const,
  viewport: "desktop" as const,
  maxPages: 6,
  maxTestCases: 10,
  timeoutSeconds: 30,
  retryCount: 0,
  captureScreenshots: true,
  recordVideo: false,
  captureTrace: true,
  consoleLogging: true,
  networkLogging: true,
  visualThreshold: 0.01,
};

/** Polls the database until `check` returns a value, or fails with a useful message. */
export async function waitFor<T>(description: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 120_000, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value as T;
    last = value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description} (last value: ${JSON.stringify(last)})`);
}

/** Removes every row created by an integration user, leaving the developer's data untouched. */
export async function cleanUpOrganization(organizationId: string) {
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

/** True when the configured PostgreSQL is actually reachable. */
export async function databaseReachable() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
