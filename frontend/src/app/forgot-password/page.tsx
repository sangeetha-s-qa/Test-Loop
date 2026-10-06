"use client";

import { use, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CheckCircle2 } from "lucide-react";
import { Button, Field, Input, PasswordInput } from "@/components/ui";
import { Wordmark } from "@/components/logo";
import { CodeSentNotice, EmailNotConfiguredNotice, OtpCodeInput, ResendCode, otpErrorMessage, useEmailStatus, type Challenge } from "@/components/auth/otp";
import { ApiError, api } from "@/lib/api";

type Errors = { email?: string; code?: string; password?: string; confirm?: string; form?: string };

const MIN_PASSWORD = 12;

/**
 * Password reset in two steps: request a code for an address, then enter it with a new password.
 * The first step answers the same way whether or not the address has an account, so this page
 * cannot be used to find out who is registered. A successful reset signs out every device.
 */
export default function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email: prefill } = use(searchParams);
  const [email, setEmail] = useState(prefill ?? "");
  const [challenge, setChallenge] = useState<{ value: Challenge; issuedAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const emailStatus = useEmailStatus();

  const request = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setErrors({ email: "Please enter a valid email address." });
    setBusy(true);
    setErrors({});
    try {
      const sent = await api.post<Challenge>("/api/v1/auth/forgot-password", { email: email.trim() });
      // The server masks nothing here on purpose; the generic wording comes from not naming the address as registered.
      setChallenge({ value: { ...sent, email: null }, issuedAt: Date.now() });
    } catch (caught) {
      setErrors({ form: caught instanceof ApiError ? (caught.status === 0 ? "The control plane is unreachable. Check that the API is running." : caught.message) : "The request could not be sent." });
    } finally {
      setBusy(false);
    }
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    const found: Errors = {};
    if (!/^\d{6}$/.test(code)) found.code = "Enter the 6-digit code from the email.";
    if (password.length < MIN_PASSWORD) found.password = `Password must be at least ${MIN_PASSWORD} characters.`;
    else if (password.length > 128) found.password = "Password must be 128 characters or fewer.";
    if (confirm !== password) found.confirm = "Passwords do not match.";
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      await api.post("/api/v1/auth/reset-password", { challengeId: challenge.value.challengeId, code, password });
      setDone(true);
    } catch (caught) {
      setErrors({ code: otpErrorMessage(caught) });
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7fb] p-5">
      <div className="w-full max-w-md py-8">
        <Link href="/" className="mb-6 flex items-center justify-center" aria-label="Testloop home">
          <Wordmark size={30} />
        </Link>

        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          {emailStatus && !emailStatus.otpEnabled ? (
            <div>
              <Link href="/login" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
                <ArrowLeft size={15} /> Back to sign in
              </Link>
              <h1 className="font-display text-2xl font-bold text-slate-900">Password reset is not available</h1>
              <p className="mt-2 text-sm text-slate-500">Resetting a password by email is switched off on this server. Ask your workspace owner or administrator for help signing in.</p>
            </div>
          ) : done ? (
            <div className="text-center">
              <CheckCircle2 size={40} className="mx-auto text-emerald-600" />
              <h1 className="mt-3 font-display text-2xl font-bold text-slate-900">Password reset</h1>
              <p className="mt-2 text-sm text-slate-500">Your password has been changed and every device has been signed out. Sign in with your new password.</p>
              <Link href="/login" className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
                Sign in
              </Link>
            </div>
          ) : !challenge ? (
            <form onSubmit={request} noValidate>
              <Link href="/login" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
                <ArrowLeft size={15} /> Back to sign in
              </Link>
              <h1 className="font-display text-2xl font-bold text-slate-900">Forgot your password?</h1>
              <p className="mt-1.5 text-sm text-slate-500">Enter your account email and we&apos;ll send you a code to reset it.</p>
              <EmailNotConfiguredNotice status={emailStatus} />
              {errors.form && (
                <p role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
                  {errors.form}
                </p>
              )}
              <div className="mt-6">
                <Field label="Email" htmlFor="forgot-email" error={errors.email} required>
                  <Input id="forgot-email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} invalid={Boolean(errors.email)} disabled={busy} autoFocus />
                </Field>
              </div>
              <Button type="submit" loading={busy} className="mt-6 w-full">
                {busy ? "Sending…" : "Send reset code"}
              </Button>
            </form>
          ) : (
            <form onSubmit={reset} noValidate>
              <button type="button" onClick={() => setChallenge(null)} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
                <ArrowLeft size={15} /> Use a different email
              </button>
              <h1 className="font-display text-2xl font-bold text-slate-900">Choose a new password</h1>
              <div className="mt-5">
                <CodeSentNotice key={challenge.value.challengeId} challenge={challenge.value} issuedAt={challenge.issuedAt} />
              </div>

              <div className="mt-6">
                <p className="mb-2 text-sm font-semibold text-slate-800">Reset code</p>
                <OtpCodeInput value={code} onChange={next => { setCode(next); setErrors(current => ({ ...current, code: undefined })); }} invalid={Boolean(errors.code)} disabled={busy} autoFocus describedBy="reset-code-error" />
                <p id="reset-code-error" role="alert" className="mt-2 min-h-5 text-sm font-medium text-rose-600">
                  {errors.code}
                </p>
              </div>

              <div className="mt-2 flex flex-col gap-4">
                <Field label="New password" htmlFor="reset-password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`} required>
                  <PasswordInput id="reset-password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} invalid={Boolean(errors.password)} disabled={busy} />
                </Field>
                <Field label="Confirm new password" htmlFor="reset-confirm" error={errors.confirm} required>
                  <PasswordInput id="reset-confirm" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} invalid={Boolean(errors.confirm)} disabled={busy} />
                </Field>
                {password.length > 0 && (
                  <p className={`flex items-center gap-1.5 text-xs font-medium ${password.length >= MIN_PASSWORD ? "text-emerald-700" : "text-slate-500"}`}>
                    <Check size={13} className={password.length >= MIN_PASSWORD ? "" : "opacity-30"} />
                    {password.length >= MIN_PASSWORD ? `${password.length} characters` : `${password.length} of ${MIN_PASSWORD} characters`}
                  </p>
                )}
              </div>

              <Button type="submit" loading={busy} className="mt-6 w-full">
                {busy ? "Resetting…" : "Reset password"}
              </Button>
              <div className="mt-5">
                <ResendCode
                  key={challenge.value.challengeId}
                  challenge={challenge.value}
                  issuedAt={challenge.issuedAt}
                  onResent={next => {
                    setChallenge({ value: { ...next, email: null }, issuedAt: Date.now() });
                    setCode("");
                  }}
                  onError={message => setErrors({ code: message })}
                />
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
