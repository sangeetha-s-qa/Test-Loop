import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../server";
import { prisma } from "../db";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "./harness";

/**
 * The bug board and tracking dashboard against real rows: bugs raised from a manual run, worked
 * through the workflow by an invited developer, then read back as board columns and metrics.
 */

type Column = { key: string; statuses: string[]; bugs: { id: string; allowedTransitions: string[]; assignee: { id: string } | null }[] };

describe("bug board and tracking dashboard", () => {
  let owner: Agent;
  let mallory: Agent;
  let devCookie: string;
  let devId: string;
  const ids: Record<"assigned" | "unassigned" | "closed", string> = { assigned: "", unassigned: "", closed: "" };
  const asDev = (method: "get" | "post", path: string) => request(app)[method](path).set("Cookie", devCookie);

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    owner = await signUp(app, "board-owner");
    mallory = await signUp(app, "board-mallory");

    const invite = await owner.post("/api/v1/invitations", { email: `board-dev-${Date.now()}@integration.test`, team: "DEVELOPER", role: "MEMBER" }).expect(201);
    const accepted = await request(app).post("/api/v1/invitations/accept").send({ token: String(invite.body.data.inviteUrl).split("/invite/")[1], name: "Board Dev", password: "invited-member-password-1" }).expect(201);
    devCookie = (accepted.headers["set-cookie"] as unknown as string[]).find(value => value.startsWith("qa_session="))!.split(";")[0];
    devId = accepted.body.data.user.id;

    const project = await owner.post("/api/v1/projects", { name: "Board app", description: "", applicationUrl: "http://127.0.0.1:4326/" }).expect(201);
    const run = await owner.post("/api/v1/test-runs", { projectId: project.body.data.id, applicationUrl: "http://127.0.0.1:4326/", requirements: "", testingTypes: ["Functional", "Smoke"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true, testingMethod: "MANUAL", applicationType: "SAAS" }).expect(201);
    const runId = run.body.data.id;
    await owner.post(`/api/v1/manual-runs/${runId}/test-cases/generate`).expect(201);
    const cases = (await owner.get(`/api/v1/manual-runs/${runId}/test-cases`).expect(200)).body.data as { id: string }[];
    for (const item of cases.slice(0, 3)) await owner.patch(`/api/v1/manual-runs/${runId}/test-cases/${item.id}`, { status: "FAILED", actualResult: "Broken", testerNotes: "Seen twice" }).expect(200);

    ids.assigned = (await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${cases[0].id}/bug`, { priority: "P1", severity: "CRITICAL", assigneeId: devId }).expect(201)).body.data.id;
    ids.unassigned = (await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${cases[1].id}/bug`, { priority: "P2" }).expect(201)).body.data.id;
    ids.closed = (await owner.post(`/api/v1/manual-runs/${runId}/test-cases/${cases[2].id}/bug`, { assigneeId: devId }).expect(201)).body.data.id;
    for (const step of [{ to: "IN_PROGRESS" }, { to: "FIXED", resolution: "Patched" }, { to: "READY_FOR_RETEST" }]) await asDev("post", `/api/v1/bugs/${ids.closed}/transition`).send(step).expect(200);
    await owner.post(`/api/v1/bugs/${ids.closed}/transition`, { to: "VERIFIED" }).expect(200);
    await owner.post(`/api/v1/bugs/${ids.closed}/transition`, { to: "CLOSED" }).expect(200);
  });

  afterAll(async () => {
    const memberIds = (await prisma.organizationMembership.findMany({ where: { organizationId: owner.organizationId }, select: { userId: true } })).map(row => row.userId);
    await cleanUpOrganization(owner.organizationId);
    await cleanUpOrganization(mallory.organizationId);
    await prisma.user.deleteMany({ where: { id: { in: [...memberIds, owner.userId, mallory.userId] } } });
    await prisma.$disconnect();
  });

  it("groups bugs into workflow columns, with the moves each viewer may make", async () => {
    const board = (await owner.get("/api/v1/bugs/board").expect(200)).body.data;
    const columns = board.columns as Column[];
    expect(columns.map(column => column.key)).toEqual(["NEW", "ASSIGNED", "IN_PROGRESS", "FIXED", "READY_FOR_RETEST", "DONE", "PARKED"]);
    const where = (id: string) => columns.find(column => column.bugs.some(bug => bug.id === id))!.key;
    expect(where(ids.unassigned)).toBe("NEW");
    expect(where(ids.assigned)).toBe("ASSIGNED");
    expect(where(ids.closed)).toBe("DONE");

    const ownerCard = columns.find(column => column.key === "ASSIGNED")!.bugs.find(bug => bug.id === ids.assigned)!;
    expect(ownerCard.allowedTransitions).toEqual(expect.arrayContaining(["IN_PROGRESS", "NEW", "REJECTED", "DEFERRED"]));

    // The developer sees only the moves that are theirs to make.
    const devColumns = (await asDev("get", "/api/v1/bugs/board").expect(200)).body.data.columns as Column[];
    expect(devColumns.find(column => column.key === "ASSIGNED")!.bugs.find(bug => bug.id === ids.assigned)!.allowedTransitions).toEqual(["IN_PROGRESS"]);
    expect(devColumns.find(column => column.key === "NEW")!.bugs.find(bug => bug.id === ids.unassigned)!.allowedTransitions).toEqual([]);
  });

  it("filters the board like the list, and lets finished bugs age off", async () => {
    const mine = (await asDev("get", "/api/v1/bugs/board?assignee=me").expect(200)).body.data.columns as Column[];
    expect(mine.flatMap(column => column.bugs.map(bug => bug.id)).sort()).toEqual([ids.assigned, ids.closed].sort());
    const p1 = (await owner.get("/api/v1/bugs/board?priority=P1").expect(200)).body.data.columns as Column[];
    expect(p1.flatMap(column => column.bugs.map(bug => bug.id))).toEqual([ids.assigned]);

    await prisma.$executeRaw`UPDATE "Bug" SET "updatedAt" = now() - interval '30 days' WHERE id = ${ids.closed}::uuid`;
    const recent = (await owner.get("/api/v1/bugs/board?doneDays=14").expect(200)).body.data.columns as Column[];
    expect(recent.find(column => column.key === "DONE")!.bugs.some(bug => bug.id === ids.closed)).toBe(false);
    const wider = (await owner.get("/api/v1/bugs/board?doneDays=60").expect(200)).body.data.columns as Column[];
    expect(wider.find(column => column.key === "DONE")!.bugs.some(bug => bug.id === ids.closed)).toBe(true);
    await owner.get("/api/v1/bugs/board?doneDays=0").expect(400);
  });

  it("computes tracking metrics from the stored bugs and their history", async () => {
    const metrics = (await owner.get("/api/v1/bugs/metrics?days=30&tz=-330").expect(200)).body.data;
    expect(metrics.kpis).toMatchObject({ open: 2, openP1: 1, openCritical: 1, unassigned: 1, createdInWindow: 3, resolvedInWindow: 1, reopenRate: 0 });
    expect(metrics.kpis.medianHoursToFix).toEqual(expect.any(Number));
    expect(metrics.kpis.medianHoursToVerify).toEqual(expect.any(Number));
    expect(metrics.trend).toHaveLength(30);
    expect(metrics.trend.reduce((sum: number, point: { created: number }) => sum + point.created, 0)).toBe(3);
    expect(metrics.byStatus.find((row: { status: string }) => row.status === "CLOSED").count).toBe(1);
    const dev = metrics.workload.find((row: { id: string | null }) => row.id === devId);
    expect(dev).toMatchObject({ open: 1, byPriority: { P1: 1 } });
    expect(metrics.workload.find((row: { id: string | null }) => row.id === null)).toMatchObject({ open: 1 });
    await owner.get("/api/v1/bugs/metrics?days=5").expect(400);
  });

  it("keeps every organization's board and metrics to itself", async () => {
    const board = (await mallory.get("/api/v1/bugs/board").expect(200)).body.data.columns as Column[];
    expect(board.flatMap(column => column.bugs)).toHaveLength(0);
    expect((await mallory.get("/api/v1/bugs/metrics").expect(200)).body.data.kpis.open).toBe(0);
    await request(app).get("/api/v1/bugs/board").expect(401);
    await request(app).get("/api/v1/bugs/metrics").expect(401);
  });
});
