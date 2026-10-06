import { SMTPServer } from "smtp-server";

/**
 * A real SMTP server for tests, so emailed codes travel the exact path production mail does
 * (nodemailer -> SMTP -> inbox) instead of being read out of a mock. Only used by the test suites;
 * `setup-env.ts` points SMTP_HOST/SMTP_PORT at it so a test run never emails a real address.
 */

export type ReceivedMail = { to: string[]; raw: string; receivedAt: number };

type Sink = { messages: ReceivedMail[]; ready: Promise<void> };

const globalSink = globalThis as typeof globalThis & { __testMailSink?: Sink };

/** Starts once per test process. Vitest re-imports modules per file, so the server lives on globalThis. */
export function startMailSink(port = Number(process.env.SMTP_PORT ?? 2526)): Sink {
  if (globalSink.__testMailSink) return globalSink.__testMailSink;
  const messages: ReceivedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", chunk => chunks.push(chunk as Buffer));
      stream.on("end", () => {
        messages.push({ to: session.envelope.rcptTo.map(item => item.address.toLowerCase()), raw: Buffer.concat(chunks).toString("utf8"), receivedAt: Date.now() });
        callback();
      });
    },
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  // Never keep a finished test process alive.
  (server as unknown as { server?: { unref?: () => void } }).server?.unref?.();
  globalSink.__testMailSink = { messages, ready };
  return globalSink.__testMailSink;
}

/** The newest message to `email` received after `since`. */
export async function waitForMail(email: string, since = 0, timeoutMs = 15_000): Promise<ReceivedMail> {
  const sink = startMailSink();
  await sink.ready;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sink.messages.filter(message => message.to.includes(email.toLowerCase()) && message.receivedAt >= since).at(-1);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`No email to ${email} arrived within ${timeoutMs}ms`);
}

/** The 6-digit code in the newest email to `email`. */
export async function waitForOtp(email: string, since = 0) {
  const message = await waitForMail(email, since);
  const code = message.raw.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`The email to ${email} contained no 6-digit code`);
  return code;
}

export const mailCount = (email: string) => startMailSink().messages.filter(message => message.to.includes(email.toLowerCase())).length;
