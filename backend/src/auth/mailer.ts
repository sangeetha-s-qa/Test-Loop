import nodemailer, { type Transporter } from "nodemailer";
import type { EmailOtpPurpose } from "@prisma/client";
import { config } from "../config";

/**
 * Outgoing email over plain SMTP.
 *
 * There is deliberately no fallback that logs a code to the console or pretends a message was sent:
 * a code that never reaches an inbox is a sign-in nobody can complete, and a code printed to a log is
 * a credential in a log file. Unconfigured means EMAIL_NOT_CONFIGURED, said out loud.
 */

export class EmailError extends Error {
  constructor(
    public readonly code: "EMAIL_NOT_CONFIGURED" | "EMAIL_SEND_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

export const emailConfigured = () => Boolean(config.SMTP_HOST && (config.SMTP_FROM || config.SMTP_USER));

let transporter: Transporter | null = null;
const transport = () => {
  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === "true",
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return transporter;
};

export async function sendEmail(message: { to: string; subject: string; text: string; html: string }) {
  if (!emailConfigured()) throw new EmailError("EMAIL_NOT_CONFIGURED", "Email delivery is not configured on this server.");
  try {
    await transport().sendMail({ from: config.SMTP_FROM ?? config.SMTP_USER, ...message });
  } catch (error) {
    // The SMTP reply can carry the server's host name or account details, so only the code is logged.
    console.error(JSON.stringify({ event: "email.send_failed", code: (error as { code?: string }).code ?? "UNKNOWN" }));
    throw new EmailError("EMAIL_SEND_FAILED", "The email could not be sent. Please try again in a moment.");
  }
}

const purposeCopy: Record<EmailOtpPurpose, { subject: string; lead: string }> = {
  SIGNUP_VERIFICATION: { subject: "Verify your email for Testloop", lead: "Use this code to verify your email address and finish creating your Testloop workspace." },
  SIGN_IN: { subject: "Your Testloop sign-in code", lead: "Use this code to finish signing in to Testloop." },
  PASSWORD_RESET: { subject: "Reset your Testloop password", lead: "Use this code to reset your Testloop password." },
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

export function otpEmail(purpose: EmailOtpPurpose, name: string, code: string, minutes: number) {
  const copy = purposeCopy[purpose];
  const ignore = purpose === "SIGN_IN" ? "If this wasn't you, someone has your password: reset it now." : "If you didn't request this, you can ignore this email.";
  return {
    subject: copy.subject,
    text: `Hi ${name},\n\n${copy.lead}\n\n${code}\n\nThe code expires in ${minutes} minutes and can be used once. Never share it - Testloop will never ask you for it.\n\n${ignore}\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0b1224">
  <p>Hi ${escapeHtml(name)},</p>
  <p>${copy.lead}</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f5f7fb;border-radius:8px;padding:16px;text-align:center">${code}</p>
  <p style="color:#475569;font-size:13px">The code expires in ${minutes} minutes and can be used once. Never share it &mdash; Testloop will never ask you for it.</p>
  <p style="color:#475569;font-size:13px">${ignore}</p>
</div>`,
  };
}

export function passwordChangedEmail(name: string) {
  const text = `Hi ${name},\n\nYour Testloop password was just changed and every existing session was signed out.\n\nIf this wasn't you, reset your password immediately and contact your workspace owner.\n`;
  return { subject: "Your Testloop password was changed", text, html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0b1224"><p>Hi ${escapeHtml(name)},</p><p>Your Testloop password was just changed and every existing session was signed out.</p><p style="color:#475569;font-size:13px">If this wasn't you, reset your password immediately and contact your workspace owner.</p></div>` };
}
