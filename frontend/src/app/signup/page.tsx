"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check } from "lucide-react";
import { Button, Field, Input, PasswordInput } from "@/components/ui";
import { Wordmark } from "@/components/logo";
import { CodeSentNotice, EmailNotConfiguredNotice, OtpCodeInput, ResendCode, isChallenge, otpErrorMessage, useEmailStatus, type Challenge } from "@/components/auth/otp";
import { ApiError, api, type Me } from "@/lib/api";

type Errors = { name?: string; organizationName?: string; email?: string; password?: string; confirm?: string; code?: string; form?: string };

const MIN_PASSWORD = 12;

/** Mirrors the server's rules so a rejection is explained before a request is spent on it. */
function passwordProblem(value: string) {
  if (!value) return "Password is required.";
  if (value.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (value.length > 128) return "Password must be 128 characters or fewer.";
  return null;
}

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  // Set once the account exists and its verification code has been emailed.
  const [challenge, setChallenge] = useState<{ value: Challenge; issuedAt: number } | null>(null);
  const [code, setCode] = useState("");
  const emailStatus = useEmailStatus();

  const validate = (): Errors => {
    const next: Errors = {};
    if (name.trim().length < 2) next.name = "Enter your full name.";
    if (organizationName.trim().length < 2) next.organizationName = "Enter a workspace name.";
    if (!email.trim()) next.email = "Email is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = "Please enter a valid email address.";
    const password_ = passwordProblem(password);
    if (password_) next.password = password_;
    if (!confirm) next.confirm = "Confirm your password.";
    else if (confirm !== password) next.confirm = "Passwords do not match.";
    return next;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      const sent = await api.post<Challenge | Me>("/api/v1/auth/signup", {
        name: name.trim(),
        organizationName: organizationName.trim(),
        email: email.trim(),
        password,
      });
      if (!isChallenge(sent)) {
        // Emailed codes are archived on this server: sign-up started the session directly.
        router.push("/dashboard");
        router.refresh();
        return;
      }
      // The account exists but has no session until the emailed code proves the address.
      setChallenge({ value: sent, issuedAt: Date.now() });
      setCode("");
      setBusy(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setErrors({ email: "An account already exists with this email." });
      else if (caught instanceof ApiError && caught.status === 503) setErrors({ form: caught.message });
      else if (caught instanceof ApiError && caught.status === 429) setErrors({ form: "Too many attempts. Please wait a few minutes and try again." });
      else if (caught instanceof ApiError && caught.code === "VALIDATION_FAILED") {
        // Map the server's field paths onto the same inline slots the client checks use.
        const details = (caught.details ?? []) as { path?: string; message?: string }[];
        const mapped: Errors = {};
        for (const issue of details) {
          if (issue.path === "email") mapped.email = issue.message;
          else if (issue.path === "password") mapped.password = issue.message;
          else if (issue.path === "name") mapped.name = issue.message;
          else if (issue.path === "organizationName") mapped.organizationName = issue.message;
        }
        setErrors(Object.keys(mapped).length ? mapped : { form: "Please check the details and try again." });
      } else if (caught instanceof ApiError && caught.status === 0) setErrors({ form: "The control plane is unreachable. Check that the API is running." });
      else setErrors({ form: "Unable to create the account. Please try again." });
      setBusy(false);
    }
  };

  const verify = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) return setErrors({ code: "Enter the 6-digit code from the email." });
    setBusy(true);
    setErrors({});
    try {
      await api.post<Me>("/api/v1/auth/otp/verify", { challengeId: challenge.value.challengeId, code });
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setErrors({ code: otpErrorMessage(caught) });
      setCode("");
      setBusy(false);
    }
  };

  const strongEnough = passwordProblem(password) === null;

  if (challenge) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f5f7fb] p-5">
        <div className="w-full max-w-md py-8">
          <Link href="/" className="mb-6 flex items-center justify-center" aria-label="Testloop home">
            <Wordmark size={30} />
          </Link>
          <form onSubmit={verify} noValidate className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <Link href="/login" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
              <ArrowLeft size={15} /> Sign in instead
            </Link>
            <h1 className="font-display text-2xl font-bold text-slate-900">Verify your email</h1>
            <p className="mt-1.5 text-sm text-slate-500">Your workspace is created. Enter the code to confirm this address is yours.</p>
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
                describedBy="signup-code-error"
              />
              <p id="signup-code-error" role="alert" className="mt-2 min-h-5 text-sm font-medium text-rose-600">
                {errors.code}
              </p>
            </div>
            <Button type="submit" loading={busy} disabled={code.length !== 6} className="mt-2 w-full">
              {busy ? "Verifying…" : "Verify email"}
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
            <p className="mt-4 text-center text-xs text-slate-400">Left this page? Sign in with your email and password - the code you get then verifies the address too.</p>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7fb] p-5">
      <div className="w-full max-w-md py-8">
        <Link href="/" className="mb-6 flex items-center justify-center" aria-label="Testloop home">
          <Wordmark size={30} />
        </Link>

        <form onSubmit={submit} noValidate className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="font-display text-2xl font-bold text-slate-900">Create your workspace</h1>
          <p className="mt-1.5 text-sm text-slate-500">Start testing an application in a few minutes.</p>
          <EmailNotConfiguredNotice status={emailStatus} />

          {errors.form && (
            <p role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
              {errors.form}
            </p>
          )}

          <div className="mt-6 flex flex-col gap-4">
            <Field label="Full name" htmlFor="signup-name" error={errors.name} required>
              <Input id="signup-name" name="name" autoComplete="name" placeholder="Sangeetha S" value={name} onChange={event => setName(event.target.value)} invalid={Boolean(errors.name)} disabled={busy} />
            </Field>

            <Field label="Workspace" htmlFor="signup-org" error={errors.organizationName} hint="Your team or company name." required>
              <Input id="signup-org" name="organizationName" autoComplete="organization" placeholder="Acme QA" value={organizationName} onChange={event => setOrganizationName(event.target.value)} invalid={Boolean(errors.organizationName)} disabled={busy} />
            </Field>

            <Field label="Email" htmlFor="signup-email" error={errors.email} required>
              <Input id="signup-email" name="email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} invalid={Boolean(errors.email)} disabled={busy} />
            </Field>

            <Field label="Password" htmlFor="signup-password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`} required>
              <PasswordInput id="signup-password" name="password" autoComplete="new-password" placeholder="Choose a strong password" value={password} onChange={event => setPassword(event.target.value)} invalid={Boolean(errors.password)} disabled={busy} />
            </Field>

            <Field label="Confirm password" htmlFor="signup-confirm" error={errors.confirm} required>
              <PasswordInput id="signup-confirm" name="confirmPassword" autoComplete="new-password" placeholder="Re-enter your password" value={confirm} onChange={event => setConfirm(event.target.value)} invalid={Boolean(errors.confirm)} disabled={busy} />
            </Field>

            {password.length > 0 && (
              <p className={`flex items-center gap-1.5 text-xs font-medium ${strongEnough ? "text-emerald-700" : "text-slate-500"}`}>
                <Check size={13} className={strongEnough ? "" : "opacity-30"} />
                {password.length} of {MIN_PASSWORD} characters
              </p>
            )}
          </div>

          <Button type="submit" loading={busy} className="mt-7 w-full">
            {busy ? "Creating your workspace…" : "Create account"}
          </Button>

          <p className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link href="/login" className="font-semibold text-violet-600 hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}
