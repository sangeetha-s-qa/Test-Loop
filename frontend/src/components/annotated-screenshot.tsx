"use client";

import { useRef, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { ApiError, annotationColours, api, type Annotation, type AnnotationColour, type Artifact } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

/**
 * A screenshot with regions drawn over it.
 *
 * The image is never modified. Boxes are stored as fractions of its width and height and painted as
 * an SVG layer on top, so the original artifact still matches the checksum it was stored with, a
 * box can be moved or relabelled afterwards, and one screenshot can carry regions for several bugs.
 * Toggling "Original" hides the layer rather than loading a different file — there is only one file.
 */

type Draft = { x: number; y: number; width: number; height: number };

const colourOptions: AnnotationColour[] = ["ROSE", "AMBER", "VIOLET", "EMERALD"];

/** Normalises a drag into a positive-area rect clamped to the image. */
function toRect(start: { x: number; y: number }, end: { x: number; y: number }): Draft {
  const x = Math.max(0, Math.min(start.x, end.x));
  const y = Math.max(0, Math.min(start.y, end.y));
  return {
    x,
    y,
    width: Math.min(1 - x, Math.abs(end.x - start.x)),
    height: Math.min(1 - y, Math.abs(end.y - start.y)),
  };
}

export function AnnotatedScreenshot({ artifact, imageUrl, bugId }: { artifact: Artifact; imageUrl: string; bugId?: string | null }) {
  const [drawing, setDrawing] = useState(false);
  const [showLayer, setShowLayer] = useState(true);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [label, setLabel] = useState("");
  const [colour, setColour] = useState<AnnotationColour>("ROSE");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  const annotations = useResource<Annotation[]>(() => api.get(`/api/v1/artifacts/${artifact.id}/annotations`), [artifact.id], {});

  /** Pointer position as a fraction of the rendered image, which is what gets stored. */
  const pointFrom = (event: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
      y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)),
    };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (!drawing || draft) return;
    const point = pointFrom(event);
    setStart(point);
    setDraft({ ...point, width: 0, height: 0 });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drawing || !start) return;
    setDraft(toRect(start, pointFrom(event)));
  };

  const onPointerUp = () => {
    if (!start) return;
    setStart(null);
    // A stray click is not a region. Anything under roughly 1% of an edge is discarded.
    setDraft(current => (current && current.width > 0.01 && current.height > 0.01 ? current : null));
  };

  const save = async () => {
    if (!draft || !label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/v1/artifacts/${artifact.id}/annotations`, { ...draft, label: label.trim(), colour, shape: "RECTANGLE", bugId: bugId ?? null });
      setDraft(null);
      setLabel("");
      annotations.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The annotation could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.delete(`/api/v1/annotations/${id}`);
      annotations.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The annotation could not be removed.");
    }
  };

  const regions = annotations.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={drawing ? "primary" : "secondary"}
          onClick={() => {
            setDrawing(value => !value);
            setDraft(null);
          }}
          icon={<Pencil size={13} />}
        >
          {drawing ? "Done drawing" : "Mark a problem"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setShowLayer(value => !value)}>
          {showLayer ? "Show original" : "Show annotations"}
        </Button>
        {drawing && <span className="text-xs text-slate-500">Drag a box around what is wrong.</span>}
        {regions.length > 0 && !drawing && (
          <span className="text-xs text-slate-500">
            {regions.length} region{regions.length === 1 ? "" : "s"} · the screenshot itself is unmodified
          </span>
        )}
      </div>

      <div
        ref={surface}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`relative select-none overflow-hidden rounded-lg border border-slate-200 bg-white ${drawing ? "cursor-crosshair" : ""}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={artifact.fileName} className="block w-full" draggable={false} />

        {showLayer && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {regions.map(region => {
              const tone = annotationColours[region.colour];
              return (
                <rect
                  key={region.id}
                  x={region.x * 100}
                  y={region.y * 100}
                  width={region.width * 100}
                  height={region.height * 100}
                  fill={tone.fill}
                  stroke={tone.stroke}
                  // Scaled stroke would smear with preserveAspectRatio="none"; this keeps it even.
                  strokeWidth={0.4}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {draft && (
              <rect x={draft.x * 100} y={draft.y * 100} width={draft.width * 100} height={draft.height * 100} fill={annotationColours[colour].fill} stroke={annotationColours[colour].stroke} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        )}

        {/* Labels are HTML rather than SVG text so they wrap, stay legible at any zoom, and can be
            positioned outside the box without clipping. */}
        {showLayer &&
          regions.map(region => (
            <span
              key={`${region.id}-label`}
              className={`pointer-events-none absolute -translate-y-full whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold text-white ${annotationColours[region.colour].chip}`}
              style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%` }}
            >
              {region.label}
            </span>
          ))}
      </div>

      {draft && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <input
            autoFocus
            value={label}
            onChange={event => setLabel(event.target.value)}
            onKeyDown={event => event.key === "Enter" && save()}
            placeholder="What is wrong here?"
            maxLength={200}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          />
          <div className="flex gap-1" role="group" aria-label="Annotation colour">
            {colourOptions.map(option => (
              <button
                key={option}
                onClick={() => setColour(option)}
                aria-label={option.toLowerCase()}
                aria-pressed={colour === option}
                className={`h-7 w-7 rounded-lg ${annotationColours[option].chip} ${colour === option ? "ring-2 ring-slate-900 ring-offset-1" : ""}`}
              />
            ))}
          </div>
          <Button size="sm" onClick={save} loading={saving} disabled={!label.trim()} icon={<Check size={13} />}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)} icon={<X size={13} />}>
            Discard
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">
          {error}
        </p>
      )}

      {regions.length > 0 && (
        <ul className="flex flex-col divide-y divide-slate-100 rounded-lg border border-slate-200">
          {regions.map(region => (
            <li key={region.id} className="flex items-center gap-3 p-2.5">
              <span className={`h-3 w-3 shrink-0 rounded-sm ${annotationColours[region.colour].chip}`} />
              <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{region.label}</span>
              <button onClick={() => remove(region.id)} aria-label={`Remove annotation: ${region.label}`} className="rounded-lg p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
