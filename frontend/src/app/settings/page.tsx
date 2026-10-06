"use client";

import { CheckCircle2, Server, XCircle } from "lucide-react";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState } from "@/components/states";
import { api, API_URL, type AiStatus, type Me } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

/**
 * Shows the operational configuration that a user can act on. It deliberately never displays a
 * connection string, an API key, or any other secret: only whether a dependency is usable.
 */
export default function SettingsPage() {
  const me = useResource(() => api.get<Me>("/api/v1/auth/me"), []);
  const ai = useResource(() => api.get<AiStatus>("/api/v1/ai/status"), []);

  return (
    <Shell title="Settings" subtitle="Workspace and provider configuration">
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="font-display text-lg font-bold">Account</h2>
          {me.loading ? (
            <div className="mt-4">
              <LoadingState label="Loading account" />
            </div>
          ) : me.error ? (
            <div className="mt-4">
              <ErrorState error={me.error} retry={me.reload} />
            </div>
          ) : (
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Name</dt>
                <dd className="truncate font-semibold">{me.data?.user?.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Email</dt>
                <dd className="truncate font-semibold">{me.data?.user?.email}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Role</dt>
                <dd className="font-semibold">{me.data?.role}</dd>
              </div>
            </dl>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold">
            <Server size={18} className="text-violet-600" />
            AI provider
          </h2>
          {ai.loading ? (
            <div className="mt-4">
              <LoadingState label="Checking provider" />
            </div>
          ) : ai.error ? (
            <div className="mt-4">
              <ErrorState error={ai.error} retry={ai.reload} />
            </div>
          ) : ai.data ? (
            <>
              <div className={`mt-4 flex items-start gap-3 rounded-lg p-4 ${ai.data.ready ? "bg-emerald-50" : "bg-amber-50"}`}>
                {ai.data.ready ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" /> : <XCircle size={18} className="mt-0.5 shrink-0 text-amber-600" />}
                <div className="min-w-0">
                  <p className={`font-semibold ${ai.data.ready ? "text-emerald-900" : "text-amber-900"}`}>{ai.data.ready ? "Provider is reachable and the model is installed" : "Provider is not usable"}</p>
                  {!ai.data.ready && (
                    <>
                      <p className="mt-1 text-sm text-amber-800">{ai.data.detail}</p>
                      <p className="mt-2 font-mono text-xs text-amber-700">{ai.data.code}</p>
                    </>
                  )}
                </div>
              </div>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Provider</dt>
                  <dd className="font-semibold">{ai.data.provider ?? "not configured"}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Model</dt>
                  <dd className="truncate font-mono text-xs font-semibold">{ai.data.model ?? "default"}</dd>
                </div>
              </dl>
              <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                Provider selection lives in the backend environment. When the provider is <code className="font-mono">ollama</code>, generation runs entirely on localhost and no external service is contacted.
              </p>
            </>
          ) : null}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-2">
          <h2 className="font-display text-lg font-bold">Control plane</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">API base URL</dt>
              <dd className="truncate font-mono text-xs font-semibold">{API_URL}</dd>
            </div>
          </dl>
          <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Database, Redis, and session secrets are never exposed through the API or shown here.
          </p>
        </section>
      </div>
    </Shell>
  );
}
