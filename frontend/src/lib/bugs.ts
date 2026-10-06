import type { Artifact, FailureAnalysis, ManualEvidence } from "@/lib/api";

/** Mirrors `backend/src/bugs/workflow.ts`. The API decides what is allowed; this only names and colours it. */

export type BugStatus = "NEW" | "ASSIGNED" | "IN_PROGRESS" | "FIXED" | "READY_FOR_RETEST" | "VERIFIED" | "CLOSED" | "REOPENED" | "REJECTED" | "DEFERRED" | "DUPLICATE";
export type BugSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type BugPriority = "P1" | "P2" | "P3" | "P4";
export type TeamFunction = "QA" | "DEVELOPER" | "PRODUCT" | "DESIGN" | "OTHER";

export const bugStatusOrder: BugStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS", "FIXED", "READY_FOR_RETEST", "VERIFIED", "CLOSED", "REOPENED", "REJECTED", "DEFERRED", "DUPLICATE"];

export const bugStatusMeta: Record<BugStatus, { label: string; tone: string }> = {
  NEW: { label: "New", tone: "bg-slate-100 text-slate-700 ring-slate-200" },
  ASSIGNED: { label: "Assigned", tone: "bg-sky-50 text-sky-700 ring-sky-200" },
  IN_PROGRESS: { label: "In progress", tone: "bg-indigo-50 text-indigo-700 ring-indigo-200" },
  FIXED: { label: "Fixed", tone: "bg-violet-50 text-violet-700 ring-violet-200" },
  READY_FOR_RETEST: { label: "Ready for retest", tone: "bg-amber-50 text-amber-800 ring-amber-200" },
  VERIFIED: { label: "Verified", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  CLOSED: { label: "Closed", tone: "bg-slate-800 text-white ring-slate-800" },
  REOPENED: { label: "Reopened", tone: "bg-rose-50 text-rose-700 ring-rose-200" },
  REJECTED: { label: "Rejected", tone: "bg-slate-100 text-slate-500 ring-slate-200 line-through" },
  DEFERRED: { label: "Deferred", tone: "bg-orange-50 text-orange-700 ring-orange-200" },
  DUPLICATE: { label: "Duplicate", tone: "bg-slate-100 text-slate-500 ring-slate-200" },
};

/** What the button for each move says. Phrased as the action, not the destination. */
export const transitionVerb: Record<BugStatus, string> = {
  NEW: "Unassign",
  ASSIGNED: "Assign",
  IN_PROGRESS: "Start work",
  FIXED: "Mark fixed",
  READY_FOR_RETEST: "Send for retest",
  VERIFIED: "Verify fix",
  CLOSED: "Close",
  REOPENED: "Reopen",
  REJECTED: "Reject",
  DEFERRED: "Defer",
  DUPLICATE: "Mark duplicate",
};

export const severityMeta: Record<BugSeverity, { label: string; tone: string }> = {
  CRITICAL: { label: "Critical", tone: "bg-rose-600 text-white ring-rose-600" },
  HIGH: { label: "High", tone: "bg-orange-50 text-orange-700 ring-orange-200" },
  MEDIUM: { label: "Medium", tone: "bg-amber-50 text-amber-800 ring-amber-200" },
  LOW: { label: "Low", tone: "bg-slate-100 text-slate-600 ring-slate-200" },
};

export const priorityMeta: Record<BugPriority, { label: string; detail: string; tone: string }> = {
  P1: { label: "P1", detail: "Urgent - fix now", tone: "bg-rose-50 text-rose-700 ring-rose-200" },
  P2: { label: "P2", detail: "High - this release", tone: "bg-orange-50 text-orange-700 ring-orange-200" },
  P3: { label: "P3", detail: "Normal", tone: "bg-sky-50 text-sky-700 ring-sky-200" },
  P4: { label: "P4", detail: "Low - when possible", tone: "bg-slate-100 text-slate-600 ring-slate-200" },
};

export const teamLabels: Record<TeamFunction, string> = { QA: "QA", DEVELOPER: "Developer", PRODUCT: "Product", DESIGN: "Design", OTHER: "Other" };

export type Person = { id: string; name: string; email?: string };

export type BugListItem = {
  id: string;
  reference: string;
  title: string;
  severity: BugSeverity;
  priority: BugPriority;
  status: BugStatus;
  source: "AUTOMATED" | "MANUAL";
  occurrenceCount: number;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; name: string };
  testCase: { id: string; testCaseId: string; title: string } | null;
  assignee: Person | null;
  reportedBy: Person | null;
  _count: { comments: number };
};

export type BugEvent = { id: string; type: string; fromValue: string | null; toValue: string | null; note: string | null; createdAt: string; actor: { id: string; name: string } | null };

export type BugDetail = Omit<BugListItem, "_count"> & {
  description: string;
  stepsToReproduce: { step: number; action: string; description: string; status: string }[];
  expectedBehavior: string;
  actualBehavior: string;
  resolution: string | null;
  fixedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  reopenCount: number;
  lastSeenAt: string;
  testRun: { id: string; applicationUrl: string; testingMethod: string } | null;
  analysis: FailureAnalysis | null;
  execution: { id: string; status: string; browser: string; failureCategory: string | null; failureMessage: string | null; completedAt: string | null; artifacts: Artifact[] } | null;
  duplicateOf: { id: string; reference: string; title: string; status: BugStatus } | null;
  duplicates: { id: string; reference: string; title: string }[];
  duplicateCandidates: { id: string; reference: string; title: string; status: BugStatus; severity: BugSeverity }[];
  comments: { id: string; body: string; createdAt: string; author: { id: string; name: string } | null }[];
  events: BugEvent[];
  manualEvidence: ManualEvidence[];
  people: Record<string, string>;
  allowedTransitions: BugStatus[];
};

export type Assignee = { id: string; name: string; email: string; team: TeamFunction; role: string; openBugs: number };

export type AppNotification = { id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string; actor: { name: string } | null; bug: { id: string; reference: string } | null };
