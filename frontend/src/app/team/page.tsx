"use client";

import { useState, type FormEvent } from "react";
import { Check, Copy, Link2, Trash2, UserPlus } from "lucide-react";
import { Avatar } from "@/components/bugs/badges";
import { ConfirmDialog } from "@/components/manual/shared";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui";
import { ApiError, api, formatDateTime, type Me } from "@/lib/api";
import { teamLabels, type TeamFunction } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

type Member = { id: string; user: { id: string; name: string; email: string }; role: string; team: TeamFunction; joinedAt: string };
type Invitation = { id: string; email: string; role: string; team: TeamFunction; expiresAt: string; createdAt: string; invitedBy: { name: string } | null };
type TeamData = { members: Member[]; invitations: Invitation[]; canManage: boolean };

const roles = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
const roleHelp: Record<string, string> = { OWNER: "Full control, including owners", ADMIN: "Manage members and everything else", MEMBER: "Test, raise, and work bugs", VIEWER: "Read only" };
const field = "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

export default function TeamPage() {
  const team = useResource(() => api.get<TeamData>("/api/v1/team"), []);
  const me = useResource(() => api.get<Me>("/api/v1/auth/me"), []);
  const [invite, setInvite] = useState({ email: "", role: "MEMBER", team: "DEVELOPER" as TeamFunction });
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      team.reload();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The change could not be saved.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sendInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invite.email.trim())) return setError("Enter a valid email address.");
    await act("invite", async () => {
      const created = await api.post<{ inviteUrl: string; email: string }>("/api/v1/invitations", { ...invite, email: invite.email.trim() });
      setLink({ email: created.email, url: created.inviteUrl });
      setCopied(false);
      setInvite(current => ({ ...current, email: "" }));
    });
  };

  if (team.loading) return <Shell title="Team"><LoadingState label="Loading team" /></Shell>;
  if (team.error || !team.data) return <Shell title="Team"><ErrorState error={team.error ?? new Error("Team not found")} retry={team.reload} /></Shell>;
  const data = team.data;
  const myId = me.data?.user?.id;

  return (
    <Shell title="Team" subtitle="Who tests, who fixes, and what each person can do">
      {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="rounded-xl border border-slate-200 bg-white">
          <h2 className="border-b border-slate-100 px-5 py-4 font-display text-base font-bold">Members ({data.members.length})</h2>
          <ul className="divide-y divide-slate-100">
            {data.members.map(member => (
              <li key={member.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Avatar name={member.user.name} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{member.user.name}{member.user.id === myId && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}</p>
                  <p className="truncate text-xs text-slate-500">{member.user.email} · joined {new Date(member.joinedAt).toLocaleDateString()}</p>
                </div>
                {data.canManage ? (
                  <>
                    <label className="sr-only" htmlFor={`team-${member.id}`}>Team for {member.user.name}</label>
                    <select id={`team-${member.id}`} value={member.team} disabled={busy !== null} onChange={event => act(`m-${member.id}`, () => api.patch(`/api/v1/team/members/${member.id}`, { team: event.target.value }))} className={field}>
                      {Object.entries(teamLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <label className="sr-only" htmlFor={`role-${member.id}`}>Role for {member.user.name}</label>
                    <select id={`role-${member.id}`} value={member.role} disabled={busy !== null} onChange={event => act(`m-${member.id}`, () => api.patch(`/api/v1/team/members/${member.id}`, { role: event.target.value }))} className={field}>
                      {roles.map(role => <option key={role} value={role} title={roleHelp[role]}>{role.charAt(0) + role.slice(1).toLowerCase()}</option>)}
                    </select>
                    {member.user.id !== myId && (
                      <button type="button" onClick={() => setRemoving(member)} aria-label={`Remove ${member.user.name}`} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                        <Trash2 size={15} />
                      </button>
                    )}
                  </>
                ) : (
                  <span className="text-xs text-slate-500">{teamLabels[member.team]} · {member.role.charAt(0) + member.role.slice(1).toLowerCase()}</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {data.canManage && (
          <aside className="space-y-4">
            <form onSubmit={sendInvite} className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="flex items-center gap-2 font-display text-base font-bold"><UserPlus size={17} /> Invite someone</h2>
              <p className="mt-1 text-xs text-slate-500">Creates a one-time link valid for 7 days. Send it yourself by chat or email - Testloop doesn&apos;t email it.</p>
              <label className="mt-4 block text-sm font-semibold text-slate-800">
                Email
                <input type="email" value={invite.email} onChange={event => setInvite(current => ({ ...current, email: event.target.value }))} placeholder="developer@company.com" className={`${field} mt-1.5 w-full`} />
              </label>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="block text-sm font-semibold text-slate-800">
                  Team
                  <select value={invite.team} onChange={event => setInvite(current => ({ ...current, team: event.target.value as TeamFunction }))} className={`${field} mt-1.5 w-full`}>
                    {Object.entries(teamLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <label className="block text-sm font-semibold text-slate-800">
                  Role
                  <select value={invite.role} onChange={event => setInvite(current => ({ ...current, role: event.target.value }))} className={`${field} mt-1.5 w-full`}>
                    {roles.filter(role => role !== "OWNER" || me.data?.role === "OWNER").map(role => <option key={role} value={role}>{role.charAt(0) + role.slice(1).toLowerCase()}</option>)}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-xs text-slate-500">{roleHelp[invite.role]}. Developers can start, fix, and send their own bugs for retest; QA verifies.</p>
              <Button type="submit" icon={<Link2 size={15} />} loading={busy === "invite"} className="mt-4 w-full">Create invite link</Button>

              {link && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-xs font-semibold text-emerald-900">Invite link for {link.email} - shown once:</p>
                  <div className="mt-2 flex gap-2">
                    <input readOnly value={link.url} onFocus={event => event.target.select()} className="min-w-0 flex-1 rounded-md border border-emerald-300 bg-white px-2 py-1.5 font-mono text-xs" aria-label="Invite link" />
                    <Button size="sm" variant="secondary" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={async () => { await navigator.clipboard.writeText(link.url); setCopied(true); }}>
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              )}
            </form>

            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="font-display text-base font-bold">Pending invitations ({data.invitations.length})</h2>
              <ul className="mt-3 space-y-2">
                {data.invitations.map(item => (
                  <li key={item.id} className="flex items-center gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-900">{item.email}</p>
                      <p className="text-xs text-slate-500">{teamLabels[item.team]} · {item.role.toLowerCase()} · expires {formatDateTime(item.expiresAt)}</p>
                    </div>
                    <Button size="sm" variant="ghost" loading={busy === `r-${item.id}`} onClick={() => act(`r-${item.id}`, () => api.delete(`/api/v1/invitations/${item.id}`))}>Revoke</Button>
                  </li>
                ))}
                {!data.invitations.length && <li className="text-sm text-slate-500">No pending invitations.</li>}
              </ul>
            </section>
          </aside>
        )}
      </div>

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.user.name}?`}
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button variant="secondary" data-autofocus onClick={() => setRemoving(null)}>Keep</Button>
              <Button variant="danger" loading={busy === "remove"} onClick={async () => { if (await act("remove", () => api.delete(`/api/v1/team/members/${removing.id}`))) setRemoving(null); }}>Remove from workspace</Button>
            </>
          }
        >
          They lose access immediately. Any open bugs assigned to them go back to New and unassigned, with a note in each bug&apos;s history.
        </ConfirmDialog>
      )}
    </Shell>
  );
}
