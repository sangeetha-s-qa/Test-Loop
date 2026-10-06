import type { BugStatus } from "@prisma/client";

/**
 * The bug lifecycle, as data and pure functions.
 *
 *   NEW ─► ASSIGNED ─► IN_PROGRESS ─► FIXED ─► READY_FOR_RETEST ─► VERIFIED ─► CLOSED
 *                ▲                                    │                │          │
 *                └──────────── REOPENED ◄─────────────┴────────────────┴──────────┘
 *   side exits from open states: REJECTED (not a bug) · DEFERRED (later) · DUPLICATE (of another)
 *
 * Kept free of I/O so the API, the UI's action buttons, and the tests apply one set of rules.
 */

export const bugStatuses = ["NEW", "ASSIGNED", "IN_PROGRESS", "FIXED", "READY_FOR_RETEST", "VERIFIED", "CLOSED", "REOPENED", "REJECTED", "DEFERRED", "DUPLICATE"] as const satisfies readonly BugStatus[];

/** Finished from the team's point of view. Everything else counts as an open bug. */
export const doneStatuses: readonly BugStatus[] = ["VERIFIED", "CLOSED", "REJECTED", "DUPLICATE"];
export const isOpenStatus = (status: BugStatus) => !doneStatuses.includes(status);

const transitions: Record<BugStatus, readonly BugStatus[]> = {
  NEW: ["ASSIGNED", "REJECTED", "DEFERRED", "DUPLICATE"],
  ASSIGNED: ["IN_PROGRESS", "NEW", "REJECTED", "DEFERRED", "DUPLICATE"],
  IN_PROGRESS: ["FIXED", "ASSIGNED", "REJECTED", "DEFERRED", "DUPLICATE"],
  FIXED: ["READY_FOR_RETEST", "REOPENED"],
  READY_FOR_RETEST: ["VERIFIED", "REOPENED"],
  VERIFIED: ["CLOSED", "REOPENED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["ASSIGNED", "IN_PROGRESS", "REJECTED", "DEFERRED", "DUPLICATE"],
  REJECTED: ["REOPENED", "CLOSED"],
  DEFERRED: ["ASSIGNED", "REOPENED", "CLOSED"],
  DUPLICATE: ["REOPENED", "CLOSED"],
};

export const statusLabels: Record<BugStatus, string> = {
  NEW: "New",
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  FIXED: "Fixed",
  READY_FOR_RETEST: "Ready for retest",
  VERIFIED: "Verified",
  CLOSED: "Closed",
  REOPENED: "Reopened",
  REJECTED: "Rejected",
  DEFERRED: "Deferred",
  DUPLICATE: "Duplicate",
};

export type Actor = { userId: string; role: string; team: string };
export type BugState = { status: BugStatus; assigneeId: string | null; reportedById: string | null };
export type TransitionInput = { to: BugStatus; note?: string | null; assigneeId?: string | null; resolution?: string | null; duplicateOfId?: string | null };
export type Verdict = { ok: true } | { ok: false; code: string; message: string; status: number };

const deny = (code: string, message: string, status = 409): Verdict => ({ ok: false, code, message, status });
const isManager = (actor: Actor) => actor.role === "OWNER" || actor.role === "ADMIN";

/**
 * Whether `actor` may move `bug` to `to`, ignoring the per-move inputs. Used to decide which buttons
 * a person sees, and as the first half of `checkTransition`.
 */
export function mayTransition(actor: Actor, bug: BugState, to: BugStatus): Verdict {
  if (actor.role === "VIEWER") return deny("FORBIDDEN", "Viewers cannot change bugs.", 403);
  if (!transitions[bug.status].includes(to)) return deny("TRANSITION_NOT_ALLOWED", `A ${statusLabels[bug.status].toLowerCase()} bug cannot move to ${statusLabels[to].toLowerCase()}.`);

  const assignee = bug.assigneeId === actor.userId;
  // Developers who are not workspace managers work the bugs assigned to them; triage, retest, and
  // closure stay with QA, product, and managers.
  if (actor.team === "DEVELOPER" && !isManager(actor)) {
    const developerMoves: BugStatus[] = ["IN_PROGRESS", "FIXED", "READY_FOR_RETEST"];
    if (!developerMoves.includes(to)) return deny("FORBIDDEN", "Developers can start, fix, and send their own bugs for retest. Ask QA or a workspace admin for other changes.", 403);
    if (!assignee) return deny("FORBIDDEN", "Only the assigned developer can change this bug's progress.", 403);
  }
  // Separation of duties: whoever was assigned the fix does not get to declare it verified, or
  // reopen their own fix from retest. Applies to managers too.
  if (bug.status === "READY_FOR_RETEST" && (to === "VERIFIED" || to === "REOPENED") && assignee) {
    return deny("SELF_VERIFICATION", "The fix must be retested by someone other than the person assigned to it.", 403);
  }
  return { ok: true };
}

/** `mayTransition` plus the inputs each move requires. */
export function checkTransition(actor: Actor, bug: BugState, input: TransitionInput): Verdict {
  const allowed = mayTransition(actor, bug, input.to);
  if (!allowed.ok) return allowed;
  const note = input.note?.trim() ?? "";
  if (input.to === "ASSIGNED" && !(input.assigneeId ?? bug.assigneeId)) return deny("ASSIGNEE_REQUIRED", "Choose who the bug is assigned to.", 422);
  if (input.to === "FIXED" && !input.resolution?.trim()) return deny("RESOLUTION_REQUIRED", "Describe what was changed to fix the bug, so QA knows what to retest.", 422);
  if ((input.to === "REJECTED" || input.to === "DEFERRED" || input.to === "REOPENED") && !note) {
    return deny("REASON_REQUIRED", `Give a reason for marking the bug ${statusLabels[input.to].toLowerCase()}.`, 422);
  }
  if (input.to === "DUPLICATE" && !input.duplicateOfId) return deny("DUPLICATE_TARGET_REQUIRED", "Choose the bug this one duplicates.", 422);
  return { ok: true };
}

/** Every move this person could make right now, for the action buttons. */
export function allowedTransitions(actor: Actor, bug: BugState): BugStatus[] {
  return transitions[bug.status].filter(to => mayTransition(actor, bug, to).ok);
}

/** Field changes that accompany a move, applied in the same write as the status. */
export function transitionEffects(bug: BugState, input: TransitionInput, now: Date) {
  switch (input.to) {
    case "NEW":
      return { assigneeId: null };
    case "ASSIGNED":
      return { assigneeId: input.assigneeId ?? bug.assigneeId };
    case "FIXED":
      return { resolution: input.resolution!.trim(), fixedAt: now };
    case "VERIFIED":
      return { verifiedAt: now };
    case "CLOSED":
      return { closedAt: now };
    case "REOPENED":
      return { fixedAt: null, verifiedAt: null, closedAt: null, reopenCount: { increment: 1 } };
    case "DUPLICATE":
      return { duplicateOfId: input.duplicateOfId };
    default:
      return {};
  }
}
