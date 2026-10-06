"use client";

import { use } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Plus } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, type Project, type TestRun } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type RunRow = TestRun & { discovery?: { status: string; pagesDiscovered: number } | null; _count?: { testCases: number; executionBatches: number } };

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Next 16 delivers route params as a promise; `use` unwraps it during render so the first paint
  // already has the id, instead of rendering an empty page and filling it in from an effect.
  const { id } = use(params);

  const project = useResource(() => api.get<Project>(`/api/v1/projects/${id}`), [id]);
  const runs = useResource(() => api.get<RunRow[]>(`/api/v1/projects/${id}/test-runs`), [id], {
    intervalMs: 4000,
    shouldPoll: rows => rows.some(row => ["QUEUED", "DISCOVERING"].includes(row.discovery?.status ?? "")),
  });

  return (
    <Shell
      title={project.data?.name ?? "Project"}
      subtitle={project.data?.applicationUrl}
      actions={
        <Link href="/test-runs/new" className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
          <Plus size={17} />
          Start new test
        </Link>
      }
    >
      <Link href="/projects" className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft size={16} />
        All projects
      </Link>

      {project.loading ? (
        <LoadingState label="Loading project" />
      ) : project.error ? (
        <ErrorState error={project.error} retry={project.reload} />
      ) : (
        <>
          <section className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-violet-600">Project</p>
                <h2 className="mt-1 font-display text-2xl font-bold">{project.data?.name}</h2>
                {project.data?.description && <p className="mt-2 max-w-2xl text-sm text-slate-600">{project.data.description}</p>}
              </div>
              <StatusBadge status={project.data?.status ?? "ACTIVE"} />
            </div>
            {project.data?.applicationUrl && (
              <a href={project.data.applicationUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-600 hover:underline">
                {project.data.applicationUrl}
                <ExternalLink size={14} />
              </a>
            )}
          </section>

          <h3 className="mb-3 font-display text-lg font-bold">Test runs</h3>
          {runs.loading ? (
            <LoadingState label="Loading test runs" />
          ) : runs.error ? (
            <ErrorState error={runs.error} retry={runs.reload} />
          ) : (runs.data?.length ?? 0) === 0 ? (
            <EmptyState
              title="No test runs yet"
              detail="Start a run against this project's URL to discover its pages and generate test cases."
              action={
                <Link href="/test-runs/new" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
                  Start the first run
                </Link>
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-4">Discovery</th>
                    <th className="px-5 py-4">Application</th>
                    <th className="px-5 py-4">Testing types</th>
                    <th className="px-5 py-4">Pages</th>
                    <th className="px-5 py-4">Created</th>
                    <th className="px-5 py-4" />
                  </tr>
                </thead>
                <tbody>
                  {runs.data?.map(run => (
                    <tr key={run.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-5 py-4">
                        <StatusBadge status={run.discovery?.status ?? run.status} />
                      </td>
                      <td className="max-w-[240px] truncate px-5 py-4 text-slate-600">{run.applicationUrl}</td>
                      <td className="px-5 py-4 text-slate-600">{run.testingTypes.join(", ") || "—"}</td>
                      <td className="px-5 py-4 text-slate-600">{run.discovery?.pagesDiscovered ?? 0}</td>
                      <td className="px-5 py-4 text-slate-500">{new Date(run.createdAt).toLocaleDateString()}</td>
                      <td className="px-5 py-4">
                        <Link href={`/test-runs/${run.id}`} className="font-semibold text-violet-600">
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
