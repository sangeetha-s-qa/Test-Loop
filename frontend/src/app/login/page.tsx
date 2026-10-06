"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button, Field, Input, PasswordInput } from "@/components/ui";
import { Wordmark } from "@/components/logo";
import { CodeSentNotice, EmailNotConfiguredNotice, OtpCodeInput, ResendCode, isChallenge, otpErrorMessage, useEmailStatus, type Challenge } from "@/components/auth/otp";
import { ApiError, api, type Me } from "@/lib/api";

type Errors = { email?: string; password?: string; code?: string; form?: string };

/**
 * Two-step sign-in: the password proves who you claim to be, the emailed code proves you hold the
 * mailbox. No session exists until both have been given.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<{ value: Challenge; issuedAt: number } | null>(null);
  const [code, setCode] = useState("");
  const emailStatus = useEmailStatus();

  /** Client-side checks mirror the server's, but the server remains the authority. */
  const validate = (): Errors => {
    const next: Errors = {};
    if (!email.trim()) next.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Please enter a valid email address.";
    if (!password) next.password = "Password is required.";
    return next;
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      const result = await api.post<Challenge | Me>("/api/v1/auth/login", { email: email.trim(), password });
      if (!isChallenge(result)) {
        // Emailed codes are archived on this server: the password alone started the session.
        router.push("/dashboard");
        router.refresh();
        return;
      }
      setChallenge({ value: result, issuedAt: Date.now() });
      setCode("");
    } catch (caught) {
      // Credentials stay deliberately generic: distinguishing "no such account" from "wrong password"
      // would confirm which addresses are registered. Email and rate-limit problems are said plainly.
      let message = "Invalid email or password.";
      if (caught instanceof ApiError) {
        if (caught.status === 0) message = "The control plane is unreachable. Check that the API is running.";
        else if (caught.status === 503 || caught.code === "OTP_RATE_LIMITED") message = caught.message;
        else if (caught.status === 429) message = "Too many attempts. Please wait a few minutes and try again.";
      }
      setErrors({ form: message });
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) return setErrors({ code: "Enter the 6-digit code from the email." });
    setBusy(true);
    setErrors({});
    try {
      await api.post<Me>("/api/v1/auth/otp/verify", { challengeId: challenge.value.challengeId, code });
      // The shell mounts fresh on the dashboard route and reads the new session there.
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setErrors({ code: otpErrorMessage(caught) });
      setCode("");
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7fb] p-5">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center" aria-label="Testloop home">
          <Wordmark size={30} />
        </Link>

        {!challenge ? (
          <form onSubmit={submitPassword} noValidate className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <h1 className="font-display text-2xl font-bold text-slate-900">Welcome back</h1>
            <p className="mt-1.5 text-sm text-slate-500">Sign in to your QA workspace.</p>
            <EmailNotConfiguredNotice status={emailStatus} />

            {errors.form && (
              <p role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
                {errors.form}
              </p>
            )}

            <div className="mt-6 flex flex-col gap-4">
              <Field label="Email" htmlFor="login-email" error={errors.email} required>
                <Input id="login-email" name="email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} invalid={Boolean(errors.email)} disabled={busy} />
              </Field>

              <Field label="Password" htmlFor="login-password" error={errors.password} required>
                <PasswordInput id="login-password" name="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={event => setPassword(event.target.value)} invalid={Boolean(errors.password)} disabled={busy} />
              </Field>
              {emailStatus?.otpEnabled && (
                <Link href={`/forgot-password${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ""}`} className="-mt-1 self-end text-sm font-semibold text-violet-600 hover:underline">
                  Forgot password?
                </Link>
              )}
            </div>

            <Button type="submit" loading={busy} className="mt-6 w-full">
              {busy ? "Signing in…" : emailStatus?.otpEnabled ? "Continue" : "Sign in"}
            </Button>

            <p className="mt-6 text-center text-sm text-slate-500">
              No account?{" "}
              <Link href="/signup" className="font-semibold text-violet-600 hover:underline">
                Create one
              </Link>
            </p>
          </form>
        ) : (
          <form onSubmit={submitCode} noValidate className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <button type="button" onClick={() => setChallenge(null)} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
              <ArrowLeft size={15} /> Back
            </button>
            <h1 className="font-display text-2xl font-bold text-slate-900">Check your email</h1>
            <p className="mt-1.5 text-sm text-slate-500">Enter the sign-in code to finish signing in.</p>
            <div className="mt-5">
              <CodeSentNotice key={challenge.value.challengeId} challenge={challenge.value} issuedAt={challenge.issuedAt} />
            </div>

            <div className="mt-6">
              <OtpCodeInput
                value={code}
                onChange={next => {
                  setCode(next);
                  setErrors({});
                }}
                invalid={Boolean(errors.code)}
                disabled={busy}
                autoFocus
                describedBy="login-code-error"
              />
              <p id="login-code-error" role="alert" className="mt-2 min-h-5 text-sm font-medium text-rose-600">
                {errors.code}
              </p>
            </div>

            <Button type="submit" loading={busy} disabled={code.length !== 6} className="mt-2 w-full">
              {busy ? "Verifying…" : "Verify and sign in"}
            </Button>
            <div className="mt-5">
              <ResendCode
                key={challenge.value.challengeId}
                challenge={challenge.value}
                issuedAt={challenge.issuedAt}
                onResent={next => {
                  setChallenge({ value: next, issuedAt: Date.now() });
                  setCode("");
                  setErrors({});
                }}
                onError={message => setErrors({ code: message })}
              />
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
