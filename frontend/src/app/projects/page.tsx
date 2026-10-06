"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, Plus, Search } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { api, ApiError, type Project } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

export default function ProjectsPage() {
  const projects = useResource(() => api.get<Project[]>("/api/v1/projects"), []);
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects.data ?? [];
    return (projects.data ?? []).filter(project => `${project.name} ${project.description} ${project.applicationUrl}`.toLowerCase().includes(needle));
  }, [projects.data, query]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);
    const form = new FormData(event.currentTarget);
    try {
      await api.post<Project>("/api/v1/projects", {
        name: String(form.get("name") ?? "").trim(),
        description: String(form.get("description") ?? "").trim(),
        applicationUrl: String(form.get("applicationUrl") ?? "").trim(),
      });
      setShowForm(false);
      projects.reload();
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : "Unable to create the project.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Shell
      title="Projects"
      subtitle="Applications you keep release-ready"
      actions={
        <button onClick={() => setShowForm(value => !value)} className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
          <Plus size={17} />
          Create project
        </button>
      }
    >
      {showForm && (
        <form onSubmit={save} className="mb-6 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="font-display text-lg font-bold">Create project</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium">
              Name
              <input name="name" required minLength={2} maxLength={120} className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2.5 font-normal outline-violet-500" />
            </label>
            <label className="text-sm font-medium">
              Application URL
              <input name="applicationUrl" type="url" required placeholder="https://example.com" className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2.5 font-normal outline-violet-500" />
            </label>
            <label className="text-sm font-medium md:col-span-2">
              Description
              <textarea name="description" maxLength={2000} className="mt-2 min-h-24 w-full rounded-lg border border-slate-200 px-3 py-2.5 font-normal outline-violet-500" />
            </label>
          </div>
          {formError && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{formError}</p>}
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? "Saving…" : "Save project"}
            </button>
          </div>
        </form>
      )}

      <div className="mb-5 flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
        <Search size={17} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search projects" className="w-full text-slate-900 outline-none" />
      </div>

      {projects.loading ? (
        <LoadingState label="Loading projects" />
      ) : projects.error ? (
        <ErrorState error={projects.error} retry={projects.reload} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={query ? "No projects match that search" : "No projects yet"}
          detail={query ? "Try a different search term." : "Create a project to start discovering an application and generating tests."}
          action={
            !query && (
              <button onClick={() => setShowForm(true)} className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
                Create your first project
              </button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(project => (
            <article key={project.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-6">
              <Link href={`/projects/${project.id}`} className="font-display text-lg font-bold hover:text-violet-700">
                {project.name}
              </Link>
              <p className="mt-1 line-clamp-2 text-sm text-slate-500">{project.description || "No description"}</p>
              <a href={project.applicationUrl} target="_blank" rel="noreferrer" className="mt-5 flex items-center gap-2 break-all text-sm text-violet-600">
                {project.applicationUrl.replace(/^https?:\/\//, "")}
                <ExternalLink size={14} className="shrink-0" />
              </a>
              <div className="mt-auto flex justify-between border-t border-slate-100 pt-4 text-xs text-slate-400">
                <span>{project.status}</span>
                <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </Shell>
  );
}
