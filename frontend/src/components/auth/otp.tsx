"use client";

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { MailCheck } from "lucide-react";
import { ApiError, api } from "@/lib/api";

/** What the API returns whenever it has emailed a code. */
export type Challenge = { otpRequired: true; challengeId: string; email: string | null; expiresInSeconds: number; resendAfterSeconds: number };

/** Seconds left until `until`, re-rendered every second. */
export function useSecondsLeft(until: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * Six single-digit boxes that behave like one field: typing advances, Backspace steps back, and
 * pasting or OS autofill of the whole code fills every box. The first box carries
 * `autocomplete="one-time-code"` so browsers and phones can offer the code from the email.
 */
export function OtpCodeInput({ value, onChange, invalid, disabled, autoFocus, describedBy }: { value: string; onChange: (code: string) => void; invalid?: boolean; disabled?: boolean; autoFocus?: boolean; describedBy?: string }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? "");

  const setFrom = (start: number, raw: string) => {
    const incoming = raw.replace(/\D/g, "");
    if (!incoming) return;
    const next = (value.slice(0, start) + incoming).slice(0, 6);
    onChange(next);
    refs.current[Math.min(next.length, 5)]?.focus();
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (digits[index]) onChange(value.slice(0, index) + value.slice(index + 1));
      else if (index > 0) {
        onChange(value.slice(0, index - 1) + value.slice(index));
        refs.current[index - 1]?.focus();
      }
    } else if (event.key === "ArrowLeft" && index > 0) refs.current[index - 1]?.focus();
    else if (event.key === "ArrowRight" && index < 5) refs.current[index + 1]?.focus();
  };

  return (
    <div className="flex justify-between gap-2" role="group" aria-label="6-digit code">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={element => {
            refs.current[index] = element;
          }}
          value={digit}
          onChange={event => setFrom(index, event.target.value)}
          onKeyDown={event => onKeyDown(index, event)}
          onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
            event.preventDefault();
            setFrom(0, event.clipboardData.getData("text"));
          }}
          onFocus={event => event.target.select()}
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={index === 0 ? 6 : 1}
          autoFocus={autoFocus && index === 0}
          disabled={disabled}
          aria-label={`Digit ${index + 1}`}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={`h-14 w-full min-w-0 rounded-lg border bg-white text-center font-display text-2xl font-bold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:bg-slate-50 ${invalid ? "border-rose-400" : "border-slate-300"}`}
        />
      ))}
    </div>
  );
}

/** "We emailed a code to d**@x.com", with the code's own expiry counting down. */
export function CodeSentNotice({ challenge, issuedAt }: { challenge: Challenge; issuedAt: number }) {
  const left = useSecondsLeft(issuedAt + challenge.expiresInSeconds * 1000);
  return (
    <div className="flex gap-3 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
      <MailCheck size={18} className="mt-0.5 shrink-0" />
      <p>
        {challenge.email ? (
          <>
            We emailed a 6-digit code to <b>{challenge.email}</b>.
          </>
        ) : (
          <>If an account exists for that address, we emailed it a 6-digit code.</>
        )}{" "}
        {left > 0 ? <>It expires in {formatClock(left)}.</> : <b>It has expired - request a new one.</b>}
      </p>
    </div>
  );
}

/**
 * Asks for a fresh code once the server's cooldown has passed. The countdown starts from the
 * cooldown the API reported, and a 429 with `retryAfterSeconds` resets it to the server's figure.
 */
export function ResendCode({ challenge, issuedAt, onResent, onError }: { challenge: Challenge; issuedAt: number; onResent: (next: Challenge) => void; onError: (message: string) => void }) {
  const [availableAt, setAvailableAt] = useState(issuedAt + challenge.resendAfterSeconds * 1000);
  const left = useSecondsLeft(availableAt);
  const [busy, setBusy] = useState(false);

  const resend = async () => {
    setBusy(true);
    try {
      const next = await api.post<Challenge>("/api/v1/auth/otp/resend", { challengeId: challenge.challengeId });
      setAvailableAt(Date.now() + next.resendAfterSeconds * 1000);
      onResent({ ...next, email: next.email ?? challenge.email });
    } catch (caught) {
      const retry = caught instanceof ApiError ? (caught.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds : undefined;
      if (retry) setAvailableAt(Date.now() + retry * 1000);
      onError(caught instanceof ApiError ? caught.message : "The code could not be resent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <p className="text-center text-sm text-slate-500">
      Didn&apos;t get it? Check spam, or{" "}
      {left > 0 ? (
        <span className="font-semibold text-slate-400">resend in {left}s</span>
      ) : (
        <button type="button" onClick={resend} disabled={busy} className="font-semibold text-violet-600 hover:underline disabled:opacity-50">
          {busy ? "sending…" : "resend the code"}
        </button>
      )}
    </p>
  );
}

/** Turns an OTP failure from the API into the sentence the person should read. */
export function otpErrorMessage(caught: unknown) {
  if (!(caught instanceof ApiError)) return "Something went wrong. Please try again.";
  if (caught.status === 0) return "The control plane is unreachable. Check that the API is running.";
  if (caught.code === "OTP_INVALID") {
    const remaining = (caught.details as { attemptsRemaining?: number } | undefined)?.attemptsRemaining;
    return remaining ? `That code is incorrect. ${remaining} attempt${remaining === 1 ? "" : "s"} left.` : caught.message;
  }
  if (caught.code === "VALIDATION_FAILED") return "Enter the 6-digit code from the email.";
  return caught.message;
}

export type EmailStatus = { otpEnabled: boolean; configured: boolean };

/** Whether emailed codes are switched on (they are archived by default) and whether mail can be sent. */
export function useEmailStatus() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get<EmailStatus>("/api/v1/auth/email-status")
      .then(result => !cancelled && setStatus(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}

/** Warns before anyone fills in a form that cannot finish because codes are on but no email can be sent. */
export function EmailNotConfiguredNotice({ status }: { status: EmailStatus | null }) {
  if (!status?.otpEnabled || status.configured) return null;
  return (
    <p role="alert" className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      Email delivery is not configured on this server, so verification codes cannot be sent. An administrator needs to set the SMTP settings in <code className="font-mono text-xs">backend/.env</code>.
    </p>
  );
}

/** Sign-in and sign-up answer with either a code challenge (codes on) or a session (codes archived). */
export const isChallenge = (value: unknown): value is Challenge => Boolean(value && typeof value === "object" && "otpRequired" in value);
