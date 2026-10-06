"use client";

import { use, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/logo";
import { ErrorState, LoadingState } from "@/components/states";
import { Button, Field, Input, PasswordInput } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { teamLabels, type TeamFunction } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

type InviteInfo = { organizationName: string; email: string; role: string; team: TeamFunction; invitedBy: string | null; expiresAt: string };

const MIN_PASSWORD = 12;

/** Public page an invite link opens. The email comes from the invitation and cannot be changed here. */
export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const info = useResource(() => api.get<InviteInfo>(`/api/v1/invitations/lookup/${encodeURIComponent(token)}`), [token]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ name?: string; password?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (name.trim().length < 2) found.name = "Enter your full name.";
    if (password.length < MIN_PASSWORD) found.password = `Password must be at least ${MIN_PASSWORD} characters.`;
    if (confirm !== password) found.confirm = "Passwords do not match.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await api.post("/api/v1/invitations/accept", { token, name: name.trim(), password });
      router.push("/bugs");
      router.refresh();
    } catch (caught) {
      setErrors({ form: caught instanceof ApiError ? caught.message : "The invitation could not be accepted." });
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7fb] p-5">
      <div className="w-full max-w-md py-8">
        <Link href="/" className="mb-6 flex items-center justify-center" aria-label="Testloop home">
          <Wordmark size={30} />
        </Link>
        {info.loading ? (
          <LoadingState label="Checking your invitation" />
        ) : info.error || !info.data ? (
          info.error instanceof ApiError && info.error.code === "INVITE_INVALID" ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <h1 className="font-display text-xl font-bold text-slate-900">This invitation can&apos;t be used</h1>
              <p className="mt-2 text-sm text-slate-500">It may have expired, been revoked, or already been accepted. Ask the person who invited you for a new link.</p>
              <Link href="/login" className="mt-6 inline-block text-sm font-semibold text-violet-700 hover:underline">Go to sign in</Link>
            </div>
          ) : (
            <ErrorState error={info.error ?? new Error("Invitation not found")} retry={info.reload} />
          )
        ) : (
          <form onSubmit={submit} noValidate className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <h1 className="font-display text-2xl font-bold text-slate-900">Join {info.data.organizationName}</h1>
            <p className="mt-1.5 text-sm text-slate-500">
              {info.data.invitedBy ? `${info.data.invitedBy} invited you` : "You were invited"} as <b>{teamLabels[info.data.team]}</b> ({info.data.role.toLowerCase()}).
            </p>
            {errors.form && <p role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">{errors.form}</p>}
            <div className="mt-6 flex flex-col gap-4">
              <Field label="Email" htmlFor="invite-email">
                <Input id="invite-email" value={info.data.email} readOnly disabled />
              </Field>
              <Field label="Full name" htmlFor="invite-name" error={errors.name} required>
                <Input id="invite-name" autoComplete="name" value={name} onChange={event => setName(event.target.value)} invalid={Boolean(errors.name)} disabled={busy} autoFocus />
              </Field>
              <Field label="Password" htmlFor="invite-password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`} required>
                <PasswordInput id="invite-password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} invalid={Boolean(errors.password)} disabled={busy} />
              </Field>
              <Field label="Confirm password" htmlFor="invite-confirm" error={errors.confirm} required>
                <PasswordInput id="invite-confirm" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} invalid={Boolean(errors.confirm)} disabled={busy} />
              </Field>
            </div>
            <Button type="submit" loading={busy} className="mt-7 w-full">{busy ? "Joining…" : "Accept invitation"}</Button>
          </form>
        )}
      </div>
    </main>
  );
}
