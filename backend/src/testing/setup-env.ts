import path from "node:path";
import dotenv from "dotenv";

/**
 * Runs before any test module is imported, so `config.ts` (which parses `process.env` at import
 * time) sees a complete configuration.
 *
 * `.env` is loaded FIRST. `dotenv` never overwrites an existing variable, so filling in
 * placeholders before loading it would permanently shadow the developer's real `DATABASE_URL`
 * and every integration test would connect to nothing.
 */
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/** Applied only where the real configuration left a gap, so unit tests never touch a real service. */
const fallbacks: Record<string, string> = {
  NODE_ENV: "test",
  SESSION_SECRET: "test-session-secret-that-is-long-enough-for-validation",
  DATABASE_URL: "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder",
  REDIS_URL: "redis://127.0.0.1:6379",
};

for (const [key, value] of Object.entries(fallbacks)) {
  if (!process.env[key]) process.env[key] = value;
}

// Tests drive the local fixture on loopback, which the SSRF policy blocks by default.
process.env.DISCOVERY_ALLOW_LOCAL_FIXTURE = "true";
process.env.EXECUTION_ALLOW_LOCAL_FIXTURE = "true";
process.env.AUDIT_ALLOW_LOCAL_FIXTURE = "true";
// Manual-testing windows are real browsers; in a test run they are launched headless so the suite
// exercises the same code path without opening windows on the developer's desktop.
process.env.MANUAL_BROWSER_ENABLED = "true";
process.env.MANUAL_BROWSER_HEADLESS = "true";
// Email always goes to the in-process SMTP sink (testing/mail-sink.ts), never to the developer's real
// SMTP account, whatever .env says. Credentials are cleared so nothing is ever sent with them.
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "2526";
process.env.SMTP_SECURE = "false";
process.env.SMTP_FROM = "Testloop Tests <tests@testloop.local>";
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;
// The emailed-code flow is archived (off) by default, but the suites keep exercising it so it still
// works the day it is switched back on. auth-archived.integration.test.ts covers the default.
process.env.AUTH_EMAIL_OTP_ENABLED = "true";
// Short enough that the resend path can be tested without a minute-long sleep.
process.env.OTP_RESEND_COOLDOWN_SECONDS = "2";
