import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../server";
import { prisma } from "../db";
import { createSession } from "../middleware/auth";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "./harness";

/**
 * Team invitations and the bug lifecycle, end to end against the real API and database: a QA owner
 * invites a developer and a second tester, raises a bug from a failed manual case, and the bug is
 * worked through assignment, fix, retest, reopen, verification, and closure by the right people.
 */

type Session = { cookie: string; userId: string; get: (path: string) => request.Test; post: (path: string, body?: object) => request.Test; patch: (path: string, body: object) => request.Test; delete: (path: string) => request.Test };
const sessionFor = (cookie: string, userId: string): Session => ({
  cookie,
  userId,
  get: path => request(app).get(path).set("Cookie", cookie),
  post: (path, body) => request(app).post(path).set("Cookie", cookie).send(body ?? {}),
  patch: (path, body) => request(app).patch(path).set("Cookie", cookie).send(body),
  delete: path => request(app).delete(path).set("Cookie", cookie),
});
const cookieOf = (response: request.Response) => {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.find(value => value.startsWith("qa_session=") && !value.startsWith("qa_session=;"))!.split(";")[0];
};

describe("team invitations and bug workflow", () => {
  let owner: Agent;
  let mallory: Agent;
  let dev: Session;
  let tester: Session;
  let viewer: Session;
  let runId: string;
  let failedCaseId: string;
  let passedCaseId: string;
  let bugId: string;

  /** Invites `email` and accepts the link, returning the new member's session. */
  async function invite(email: string, team: string, role = "MEMBER") {
    const created = await owner.post("/api/v1/invitations", { email, team, role }).expect(201);
    const token = String(created.body.data.inviteUrl).split("/invite/")[1];
    const accepted = await request(app).post("/api/v1/invitations/accept").send({ token, name: `${team} person`, password: "invited-member-password-1" }).expect(201);
    return { session: sessionFor(cookieOf(accepted), accepted.body.data.user.id), token, invitationId: created.body.data.id as string };
  }

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    owner = await signUp(app, "bugs-owner");
    mallory = await signUp(app, "bugs-mallory");

    const project = await owner.post("/api/v1/projects", { name: "Bug flow app", description: "", applicationUrl: "http://127.0.0.1:4325/" }).expect(201);
    const run = await owner.post("/api/v1/test-runs", { projectId: project.body.data.id, applicationUrl: "http://127.0.0.1:4325/", requirements: "", testingTypes: ["Functional", "Smoke", "Security", "Accessibility"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true, testingMethod: "MANUAL", applicationType: "ECOMMERCE" }).expect(201);
    runId = run.body.data.id;
    await owner.post(`/api/v1/manual-runs/${runId}/test-cases/generate`).expect(201);
    const cases = (await owner.get(`/api/v1/manual-runs/${runId}/test-cases`).expect(200)).body.data as { id: string }[];
    failedCaseId = cases[0].id;
    passedCaseId = cases[1].id;
    await owner.patch(`/api/v1/manual-runs/${runId}/test-cases/${failedCaseId}`, { status: "FAILED", actualResult: "Checkout button does nothing", testerNotes: "Console shows TypeError on click" }).expect(200);
    await owner.patch(`/api/v1/manual-runs/${runId}/test-cases/${passedCaseId}`, { status: "PASSED" }).expect(200);
  });

  afterAll(async () => {
    const memberIds = (await prisma.organizationMembership.findMany({ where: { organizationId: owner.organizationId }, select: { userId: true } })).map(row => row.userId);
    await cleanUpOrganization(owner.organizationId);
    await cleanUpOrganization(mallory.organizationId);
    await prisma.user.deleteMany({ where: { id: { in: [...memberIds, owner.userId, mallory.userId, dev?.userId, tester?.userId, viewer?.userId].filter(Boolean) as string[] } } });
    await prisma.$disconnect();
  });

  /* ---------------------------------------------------------------- invitations */

  it("invites a developer by one-time link, who joins with that role and team", async () => {
    const email = `dev-${Date.now()}@integration.test`;
    const created = await owner.post("/api/v1/invitations", { email, team: "DEVELOPER", role: "MEMBER" }).expect(201);
    expect(created.body.data.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
    const token = String(created.body.data.inviteUrl).split("/invite/")[1];
    // Only a hash is stored.
    expect(await prisma.invitation.count({ where: { tokenHash: token } })).toBe(0);

    const lookup = await request(app).get(`/api/v1/invitations/lookup/${token}`).expect(200);
    expect(lookup.body.data).toMatchObject({ email, team: "DEVELOPER", role: "MEMBER", organizationName: "bugs-owner org" });

    const accepted = await request(app).post("/api/v1/invitations/accept").send({ token, name: "Dana Developer", password: "invited-member-password-1" }).expect(201);
    dev = sessionFor(cookieOf(accepted), accepted.body.data.user.id);
    const me = await dev.get("/api/v1/auth/me").expect(200);
    expect(me.body.data).toMatchObject({ organizationId: owner.organizationId, role: "MEMBER", user: { email } });
    expect((await prisma.organizationMembership.findFirstOrThrow({ where: { userId: dev.userId } })).team).toBe("DEVELOPER");

    // Single use, and the account cannot be claimed twice.
    const reused = await request(app).post("/api/v1/invitations/accept").send({ token, name: "Someone Else", password: "invited-member-password-2" }).expect(404);
    expect(reused.body.error.code).toBe("INVITE_INVALID");
  });

  it("rejects revoked and expired links, duplicate members, and invites from non-managers", async () => {
    const revoked = await owner.post("/api/v1/invitations", { email: `revoked-${Date.now()}@integration.test`, team: "QA" }).expect(201);
    await owner.delete(`/api/v1/invitations/${revoked.body.data.id}`).expect(204);
    await request(app).get(`/api/v1/invitations/lookup/${String(revoked.body.data.inviteUrl).split("/invite/")[1]}`).expect(404);

    const expiring = await owner.post("/api/v1/invitations", { email: `expired-${Date.now()}@integration.test`, team: "QA" }).expect(201);
    await prisma.invitation.update({ where: { id: expiring.body.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).post("/api/v1/invitations/accept").send({ token: String(expiring.body.data.inviteUrl).split("/invite/")[1], name: "Late Person", password: "invited-member-password-1" }).expect(404);

    const devEmail = (await prisma.user.findUniqueOrThrow({ where: { id: dev.userId } })).email;
    expect((await owner.post("/api/v1/invitations", { email: devEmail, team: "QA" }).expect(409)).body.error.code).toBe("ALREADY_MEMBER");
    await dev.post("/api/v1/invitations", { email: "x@integration.test", team: "QA" }).expect(403);
    await mallory.delete(`/api/v1/invitations/${expiring.body.data.id}`).expect(404);
    await request(app).get("/api/v1/invitations/lookup/not-a-real-token-at-all-xyz").expect(404);
  });

  it("adds a second tester and a viewer, and protects the last owner", async () => {
    tester = (await invite(`tester-${Date.now()}@integration.test`, "QA")).session;
    viewer = (await invite(`viewer-${Date.now()}@integration.test`, "PRODUCT", "VIEWER")).session;

    const team = await owner.get("/api/v1/team").expect(200);
    expect(team.body.data.members).toHaveLength(4);
    const ownerMember = team.body.data.members.find((member: { role: string }) => member.role === "OWNER");
    expect((await owner.patch(`/api/v1/team/members/${ownerMember.id}`, { role: "ADMIN" }).expect(409)).body.error.code).toBe("LAST_OWNER");
    const testerMember = team.body.data.members.find((member: { user: { id: string } }) => member.user.id === tester.userId);
    await tester.patch(`/api/v1/team/members/${testerMember.id}`, { role: "ADMIN" }).expect(403);
    await mallory.get("/api/v1/team").expect(200).then(response => expect(response.body.data.members).toHaveLength(1));

    const assignees = await owner.get("/api/v1/team/assignees").expect(200);
    expect(assignees.body.data[0]).toMatchObject({ id: dev.userId, team: "DEVELOPER", openBugs: 0 });
    expect(assignees.body.data.some((person: { id: string }) => person.id === viewer.userId)).toBe(false);
  });

  /* ---------------------------------------------------------------- raising */

  it("raises a bug only from a failed manual case, once, carrying the tester's findings", async () => {
    expect((await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${passedCaseId}/bug`, {}).expect(409)).body.error.code).toBe("CASE_NOT_FAILED");
    await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${failedCaseId}/bug`, { assigneeId: viewer.userId }).expect(422);

    const raised = await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${failedCaseId}/bug`, { severity: "HIGH", priority: "P1", assigneeId: dev.userId }).expect(201);
    bugId = raised.body.data.id;
    expect(raised.body.data).toMatchObject({ source: "MANUAL", status: "ASSIGNED", assigneeId: dev.userId, severity: "HIGH", priority: "P1", actualBehavior: "Checkout button does nothing", testRunId: runId, reportedById: owner.userId });
    expect(raised.body.data.reference).toMatch(/^BUG-\d{4}$/);

    const again = await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${failedCaseId}/bug`, {}).expect(200);
    expect(again.body.data.id).toBe(bugId);

    const cases = (await owner.get(`/api/v1/manual-runs/${runId}/test-cases`).expect(200)).body.data as { id: string; bugs: { reference: string }[] }[];
    expect(cases.find(item => item.id === failedCaseId)!.bugs[0].reference).toBe(raised.body.data.reference);

    const notifications = await dev.get("/api/v1/notifications").expect(200);
    expect(notifications.body.data.unreadCount).toBe(1);
    expect(notifications.body.data.items[0]).toMatchObject({ type: "BUG_ASSIGNED", bug: { id: bugId } });
  });

  it("lists bugs by assignee and status group", async () => {
    const mine = await dev.get("/api/v1/bugs?assignee=me&status=OPEN").expect(200);
    expect(mine.body.data.map((bug: { id: string }) => bug.id)).toEqual([bugId]);
    expect((await tester.get("/api/v1/bugs?assignee=me").expect(200)).body.data).toHaveLength(0);
    expect((await owner.get("/api/v1/bugs?source=MANUAL&priority=P1").expect(200)).body.data.some((bug: { id: string }) => bug.id === bugId)).toBe(true);
    await owner.get("/api/v1/bugs?status=NOT_A_STATUS").expect(400);
  });

  /* ---------------------------------------------------------------- lifecycle */

  it("lets the assigned developer start and fix it, but not triage or skip steps", async () => {
    const detail = await dev.get(`/api/v1/bugs/${bugId}`).expect(200);
    expect(detail.body.data.allowedTransitions).toEqual(["IN_PROGRESS"]);
    await dev.patch(`/api/v1/bugs/${bugId}`, { severity: "LOW" }).expect(403);
    expect((await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "FIXED", resolution: "x" }).expect(409)).body.error.code).toBe("TRANSITION_NOT_ALLOWED");
    await tester.post(`/api/v1/bugs/${bugId}/transition`, { to: "IN_PROGRESS" }).expect(200);
    await owner.post(`/api/v1/bugs/${bugId}/transition`, { to: "ASSIGNED" }).expect(200);

    await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "IN_PROGRESS" }).expect(200);
    expect((await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "FIXED" }).expect(422)).body.error.code).toBe("RESOLUTION_REQUIRED");
    const fixed = await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "FIXED", resolution: "Bound the click handler after hydration" }).expect(200);
    expect(fixed.body.data).toMatchObject({ status: "FIXED", resolution: "Bound the click handler after hydration" });
    expect(fixed.body.data.fixedAt).not.toBeNull();
    await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "READY_FOR_RETEST" }).expect(200);

    const ownerBell = await owner.get("/api/v1/notifications").expect(200);
    expect(ownerBell.body.data.items.some((item: { type: string }) => item.type === "BUG_READY_FOR_RETEST")).toBe(true);
  });

  it("keeps verification with QA, requires a reason to reopen, and tells the developer", async () => {
    await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "VERIFIED" }).expect(403);
    expect((await owner.post(`/api/v1/bugs/${bugId}/transition`, { to: "REOPENED" }).expect(422)).body.error.code).toBe("REASON_REQUIRED");
    const reopened = await owner.post(`/api/v1/bugs/${bugId}/transition`, { to: "REOPENED", note: "Still fails in Firefox" }).expect(200);
    expect(reopened.body.data).toMatchObject({ status: "REOPENED", reopenCount: 1, fixedAt: null });
    const devBell = await dev.get("/api/v1/notifications").expect(200);
    expect(devBell.body.data.items[0]).toMatchObject({ type: "BUG_REOPENED", body: "Still fails in Firefox" });

    await owner.post(`/api/v1/bugs/${bugId}/assign`, { assigneeId: dev.userId }).expect(200).then(response => expect(response.body.data.status).toBe("ASSIGNED"));
    await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "IN_PROGRESS" }).expect(200);
    await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "FIXED", resolution: "Also handled Firefox's pointer events" }).expect(200);
    await dev.post(`/api/v1/bugs/${bugId}/transition`, { to: "READY_FOR_RETEST" }).expect(200);
    const verified = await tester.post(`/api/v1/bugs/${bugId}/transition`, { to: "VERIFIED" }).expect(200);
    expect(verified.body.data.verifiedAt).not.toBeNull();
    const closed = await owner.post(`/api/v1/bugs/${bugId}/transition`, { to: "CLOSED" }).expect(200);
    expect(closed.body.data.closedAt).not.toBeNull();

    const history = (await owner.get(`/api/v1/bugs/${bugId}`).expect(200)).body.data.events.filter((event: { type: string }) => event.type === "STATUS_CHANGED").map((event: { toValue: string }) => event.toValue);
    expect(history).toEqual(["IN_PROGRESS", "ASSIGNED", "IN_PROGRESS", "FIXED", "READY_FOR_RETEST", "REOPENED", "ASSIGNED", "IN_PROGRESS", "FIXED", "READY_FOR_RETEST", "VERIFIED", "CLOSED"]);
  });

  it("never lets the assignee verify their own fix, even as an owner", async () => {
    await owner.patch(`/api/v1/manual-runs/${runId}/test-cases/${passedCaseId}`, { status: "FAILED", actualResult: "Wrong total", testerNotes: "Tax missing" }).expect(200);
    const second = await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${passedCaseId}/bug`, { assigneeId: owner.userId }).expect(201);
    for (const step of [{ to: "IN_PROGRESS" }, { to: "FIXED", resolution: "Added tax line" }, { to: "READY_FOR_RETEST" }]) await owner.post(`/api/v1/bugs/${second.body.data.id}/transition`, step).expect(200);
    expect((await owner.post(`/api/v1/bugs/${second.body.data.id}/transition`, { to: "VERIFIED" }).expect(403)).body.error.code).toBe("SELF_VERIFICATION");
    await tester.post(`/api/v1/bugs/${second.body.data.id}/transition`, { to: "VERIFIED" }).expect(200);
  });

  it("records triage changes and comments, and notifies the people involved", async () => {
    const third = await owner.post(`/api/v1/manual-runs/${runId}/bugs`, {}).expect(201);
    expect(third.body.data).toHaveLength(0);
    const cases = (await owner.get(`/api/v1/manual-runs/${runId}/test-cases`).expect(200)).body.data as { id: string }[];
    await owner.patch(`/api/v1/manual-runs/${runId}/test-cases/${cases[2].id}`, { status: "FAILED", actualResult: "Error 500", testerNotes: "Server error" }).expect(200);
    const bulk = await owner.post(`/api/v1/manual-runs/${runId}/bugs`, { priority: "P2", assigneeId: dev.userId }).expect(201);
    expect(bulk.body.data).toHaveLength(1);
    const id = bulk.body.data[0].id;

    await owner.patch(`/api/v1/bugs/${id}`, { severity: "CRITICAL", priority: "P1", dueAt: "2026-10-12T00:00:00.000Z" }).expect(200);
    await dev.post(`/api/v1/bugs/${id}/comments`, { body: "Looking into it - which browser?" }).expect(201);
    await viewer.post(`/api/v1/bugs/${id}/comments`, { body: "hi" }).expect(403);
    const detail = (await owner.get(`/api/v1/bugs/${id}`).expect(200)).body.data;
    expect(detail.comments[0]).toMatchObject({ body: "Looking into it - which browser?", author: { id: dev.userId } });
    expect(detail.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(["CREATED", "ASSIGNED", "SEVERITY_CHANGED", "PRIORITY_CHANGED", "DUE_DATE_CHANGED", "COMMENTED"]));

    const ownerBell = await owner.get("/api/v1/notifications").expect(200);
    expect(ownerBell.body.data.items[0]).toMatchObject({ type: "BUG_COMMENTED" });
    await owner.post(`/api/v1/notifications/${ownerBell.body.data.items[0].id}/read`).expect(200);
    await mallory.post(`/api/v1/notifications/${ownerBell.body.data.items[0].id}/read`).expect(404);
    await owner.post("/api/v1/notifications/read-all").expect(200);
    expect((await owner.get("/api/v1/notifications").expect(200)).body.data.unreadCount).toBe(0);
  });

  it("refuses assignees outside the workspace and invalid moves", async () => {
    const cases = (await owner.get(`/api/v1/manual-runs/${runId}/test-cases`).expect(200)).body.data as { id: string; manualStatus: string }[];
    const target = cases.find(item => item.manualStatus === "NOT_RUN")!;
    await owner.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "FAILED", actualResult: "a", testerNotes: "b" }).expect(200);
    const fresh = (await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${target.id}/bug`, {}).expect(201)).body.data;
    expect(fresh.status).toBe("NEW");
    expect((await owner.post(`/api/v1/bugs/${fresh.id}/assign`, { assigneeId: mallory.userId }).expect(422)).body.error.code).toBe("ASSIGNEE_NOT_MEMBER");
    expect((await owner.post(`/api/v1/bugs/${fresh.id}/transition`, { to: "FIXED", resolution: "x" }).expect(409)).body.error.code).toBe("TRANSITION_NOT_ALLOWED");
    expect((await owner.post(`/api/v1/bugs/${fresh.id}/transition`, { to: "DUPLICATE", duplicateOfId: fresh.id }).expect(422)).body.error.code).toBe("SELF_DUPLICATE");
    await owner.post(`/api/v1/bugs/${fresh.id}/transition`, { to: "DUPLICATE", duplicateOfId: bugId }).expect(200);
  });

  /* ---------------------------------------------------------------- isolation and removal */

  it("hides every bug, comment, and action from another organization", async () => {
    for (const path of [`/api/v1/bugs/${bugId}`]) await mallory.get(path).expect(404);
    expect((await mallory.get("/api/v1/bugs").expect(200)).body.data.some((bug: { id: string }) => bug.id === bugId)).toBe(false);
    await mallory.post(`/api/v1/bugs/${bugId}/transition`, { to: "REOPENED", note: "x" }).expect(404);
    await mallory.post(`/api/v1/bugs/${bugId}/assign`, { assigneeId: mallory.userId }).expect(404);
    await mallory.post(`/api/v1/bugs/${bugId}/comments`, { body: "x" }).expect(404);
    await mallory.patch(`/api/v1/bugs/${bugId}`, { priority: "P4" }).expect(404);
    await mallory.post(`/api/v1/manual-runs/${runId}/test-cases/${failedCaseId}/bug`, {}).expect(404);
    await mallory.post(`/api/v1/manual-runs/${runId}/bugs`, {}).expect(404);
    await request(app).get(`/api/v1/bugs/${bugId}`).expect(401);
  });

  it("returns a removed member's open bugs to the queue", async () => {
    const open = await prisma.bug.findMany({ where: { assigneeId: dev.userId, status: { notIn: ["VERIFIED", "CLOSED", "REJECTED", "DUPLICATE"] } }, select: { id: true } });
    expect(open.length).toBeGreaterThan(0);
    const team = await owner.get("/api/v1/team").expect(200);
    const devMember = team.body.data.members.find((member: { user: { id: string } }) => member.user.id === dev.userId);
    await owner.delete(`/api/v1/team/members/${devMember.id}`).expect(204);
    for (const bug of open) expect(await prisma.bug.findUniqueOrThrow({ where: { id: bug.id } })).toMatchObject({ assigneeId: null, status: "NEW" });
    await dev.get("/api/v1/bugs").expect(403);
  });

  it("does not let a viewer change anything", async () => {
    await viewer.post(`/api/v1/bugs/${bugId}/transition`, { to: "REOPENED", note: "x" }).expect(403);
    await viewer.patch(`/api/v1/bugs/${bugId}`, { priority: "P4" }).expect(403);
    const viewerSession = sessionFor(`qa_session=${createSession(viewer.userId, owner.organizationId)}`, viewer.userId);
    expect((await viewerSession.get(`/api/v1/bugs/${bugId}`).expect(200)).body.data.allowedTransitions).toEqual([]);
  });
});
