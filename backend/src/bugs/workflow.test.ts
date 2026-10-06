import { describe, expect, it } from "vitest";
import { allowedTransitions, checkTransition, isOpenStatus, mayTransition, transitionEffects, type Actor, type BugState } from "./workflow";

const qa: Actor = { userId: "qa", role: "MEMBER", team: "QA" };
const dev: Actor = { userId: "dev", role: "MEMBER", team: "DEVELOPER" };
const otherDev: Actor = { userId: "dev2", role: "MEMBER", team: "DEVELOPER" };
const admin: Actor = { userId: "admin", role: "ADMIN", team: "DEVELOPER" };
const viewer: Actor = { userId: "viewer", role: "VIEWER", team: "QA" };
const bug = (status: BugState["status"], assigneeId: string | null = "dev"): BugState => ({ status, assigneeId, reportedById: "qa" });

describe("bug workflow", () => {
  it("walks the full happy path", () => {
    expect(checkTransition(qa, bug("NEW", null), { to: "ASSIGNED", assigneeId: "dev" }).ok).toBe(true);
    expect(checkTransition(dev, bug("ASSIGNED"), { to: "IN_PROGRESS" }).ok).toBe(true);
    expect(checkTransition(dev, bug("IN_PROGRESS"), { to: "FIXED", resolution: "Kept username after failed login" }).ok).toBe(true);
    expect(checkTransition(dev, bug("FIXED"), { to: "READY_FOR_RETEST" }).ok).toBe(true);
    expect(checkTransition(qa, bug("READY_FOR_RETEST"), { to: "VERIFIED" }).ok).toBe(true);
    expect(checkTransition(qa, bug("VERIFIED"), { to: "CLOSED" }).ok).toBe(true);
  });

  it("refuses moves the lifecycle does not have", () => {
    expect(mayTransition(qa, bug("NEW", null), "FIXED")).toMatchObject({ ok: false, code: "TRANSITION_NOT_ALLOWED" });
    expect(mayTransition(qa, bug("CLOSED"), "VERIFIED")).toMatchObject({ ok: false, code: "TRANSITION_NOT_ALLOWED" });
  });

  it("requires the inputs each move needs", () => {
    expect(checkTransition(qa, bug("NEW", null), { to: "ASSIGNED" })).toMatchObject({ ok: false, code: "ASSIGNEE_REQUIRED" });
    expect(checkTransition(dev, bug("IN_PROGRESS"), { to: "FIXED", resolution: "  " })).toMatchObject({ ok: false, code: "RESOLUTION_REQUIRED" });
    expect(checkTransition(qa, bug("READY_FOR_RETEST"), { to: "REOPENED" })).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(checkTransition(qa, bug("NEW", null), { to: "REJECTED", note: "" })).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(checkTransition(qa, bug("NEW", null), { to: "DUPLICATE" })).toMatchObject({ ok: false, code: "DUPLICATE_TARGET_REQUIRED" });
  });

  it("keeps fix verification away from the assignee, managers included", () => {
    expect(mayTransition(dev, bug("READY_FOR_RETEST"), "VERIFIED")).toMatchObject({ ok: false });
    expect(mayTransition(admin, bug("READY_FOR_RETEST", "admin"), "VERIFIED")).toMatchObject({ ok: false, code: "SELF_VERIFICATION" });
    expect(mayTransition(admin, bug("READY_FOR_RETEST", "dev"), "VERIFIED").ok).toBe(true);
  });

  it("lets developers work only their own assigned bugs, and only forward", () => {
    expect(mayTransition(otherDev, bug("ASSIGNED"), "IN_PROGRESS")).toMatchObject({ ok: false, status: 403 });
    expect(mayTransition(dev, bug("NEW", null), "ASSIGNED")).toMatchObject({ ok: false, status: 403 });
    expect(mayTransition(dev, bug("ASSIGNED"), "REJECTED")).toMatchObject({ ok: false, status: 403 });
    expect(allowedTransitions(dev, bug("ASSIGNED"))).toEqual(["IN_PROGRESS"]);
    expect(allowedTransitions(otherDev, bug("ASSIGNED"))).toEqual([]);
  });

  it("gives viewers nothing", () => {
    expect(allowedTransitions(viewer, bug("NEW", null))).toEqual([]);
    expect(mayTransition(viewer, bug("NEW", null), "ASSIGNED")).toMatchObject({ status: 403 });
  });

  it("applies the field changes that go with each move", () => {
    const now = new Date("2026-10-05T10:00:00Z");
    expect(transitionEffects(bug("ASSIGNED"), { to: "NEW" }, now)).toEqual({ assigneeId: null });
    expect(transitionEffects(bug("IN_PROGRESS"), { to: "FIXED", resolution: " patched " }, now)).toEqual({ resolution: "patched", fixedAt: now });
    expect(transitionEffects(bug("CLOSED"), { to: "REOPENED", note: "Back" }, now)).toEqual({ fixedAt: null, verifiedAt: null, closedAt: null, reopenCount: { increment: 1 } });
  });

  it("counts deferred and reopened bugs as open, verified and closed ones as done", () => {
    expect(isOpenStatus("DEFERRED")).toBe(true);
    expect(isOpenStatus("REOPENED")).toBe(true);
    expect(isOpenStatus("VERIFIED")).toBe(false);
    expect(isOpenStatus("REJECTED")).toBe(false);
  });
});
