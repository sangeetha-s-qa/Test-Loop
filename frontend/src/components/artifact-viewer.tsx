"use client";

import { useEffect, useState } from "react";
import { Download, FileWarning, Image as ImageIcon, Video } from "lucide-react";
import { AnnotatedScreenshot } from "@/components/annotated-screenshot";
import { artifactUrl, formatBytes, type Artifact } from "@/lib/api";

/**
 * Loads an artifact through a short-lived signed URL minted per view. Nothing is rendered from a
 * guessed path: if the token request fails, the failure is shown rather than a broken image.
 */
function useSignedUrl(artifactId: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    artifactUrl(artifactId)
      .then(result => !cancelled && setUrl(result.url))
      .catch(caught => !cancelled && setError(caught instanceof Error ? caught.message : "Unable to load artifact"));
    return () => {
      cancelled = true;
    };
  }, [artifactId]);
  return { url, error };
}

function Preview({ artifact, annotatable, bugId }: { artifact: Artifact; annotatable?: boolean; bugId?: string | null }) {
  const { url, error } = useSignedUrl(artifact.id);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-rose-50 p-4 text-xs text-rose-700">
        <FileWarning size={15} />
        {error}
      </div>
    );
  }
  if (!url) return <div className="h-40 animate-pulse rounded-lg bg-slate-100" />;

  if (artifact.type === "SCREENSHOT" || artifact.type === "VISUAL_DIFF") {
    // The annotating variant draws regions over the same image rather than a different file; the
    // stored bytes are identical either way.
    if (annotatable) return <AnnotatedScreenshot artifact={artifact} imageUrl={url} bugId={bugId} />;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={artifact.fileName} className="w-full rounded-lg border border-slate-200 bg-white" />;
  }
  if (artifact.type === "VIDEO") {
    return <video src={url} controls className="w-full rounded-lg border border-slate-200 bg-black" />;
  }
  return (
    <a href={url} className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-6 text-sm font-semibold text-violet-700">
      <Download size={16} />
      Download {artifact.fileName}
    </a>
  );
}

const icons: Record<string, typeof ImageIcon> = { SCREENSHOT: ImageIcon, VISUAL_DIFF: ImageIcon, VIDEO: Video };

/**
 * `annotate` turns the image previews into drawable surfaces. Off by default: most views are
 * reading evidence, and only the bug view is editing it.
 */
export function ArtifactGrid({ artifacts, emptyDetail, annotate, bugId }: { artifacts: Artifact[]; emptyDetail: string; annotate?: boolean; bugId?: string | null }) {
  if (artifacts.length === 0) {
    return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{emptyDetail}</p>;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {artifacts.map(artifact => {
        const Icon = icons[artifact.type] ?? Download;
        return (
          <figure key={artifact.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <figcaption className="mb-3 flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-2 font-semibold">
                <Icon size={14} className="shrink-0 text-violet-600" />
                <span className="truncate">{artifact.fileName}</span>
              </span>
              <span className="shrink-0 text-slate-400">{formatBytes(artifact.byteSize)}</span>
            </figcaption>
            <Preview artifact={artifact} annotatable={annotate} bugId={bugId} />
            <p className="mt-2 truncate font-mono text-[10px] text-slate-400" title={artifact.checksumSha256}>
              {/* A caller may project a narrower artifact shape; a missing checksum must degrade,
                  not take the whole page down with it. */}
              {artifact.checksumSha256 ? `sha256 ${artifact.checksumSha256.slice(0, 24)}…` : "checksum unavailable"}
            </p>
          </figure>
        );
      })}
    </div>
  );
}
