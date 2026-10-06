import { bugStatusMeta, priorityMeta, severityMeta, type BugPriority, type BugSeverity, type BugStatus } from "@/lib/bugs";

const pill = "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ring-inset";

export function BugStatusBadge({ status }: { status: BugStatus }) {
  const meta = bugStatusMeta[status] ?? bugStatusMeta.NEW;
  return <span className={`${pill} ${meta.tone}`}>{meta.label}</span>;
}

export function SeverityBadge({ severity }: { severity: BugSeverity }) {
  const meta = severityMeta[severity];
  return <span className={`${pill} uppercase tracking-wide ${meta.tone}`}>{meta.label}</span>;
}

export function PriorityBadge({ priority }: { priority: BugPriority }) {
  const meta = priorityMeta[priority];
  return (
    <span className={`${pill} font-mono ${meta.tone}`} title={meta.detail}>
      {meta.label}
    </span>
  );
}

export function Avatar({ name, size = 24 }: { name: string | null | undefined; size?: number }) {
  const initials = (name ?? "?").trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("") || "?";
  return (
    <span className="grid shrink-0 place-items-center rounded-full bg-violet-100 font-bold text-violet-700" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden="true">
      {initials}
    </span>
  );
}
