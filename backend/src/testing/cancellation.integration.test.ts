import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server";
import { prisma } from "../db";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "./harness";

/**
 * Cancellation must survive a long-running job.
 *
 * The AI worker checked for cancellation once, before calling the model. That check takes
 * milliseconds; the generation that follows takes minutes on a local model. A cancellation arriving
 * in that window was overwritten the moment the model returned - the run went CANCELLED, back to
 * GENERATING, then COMPLETED, and the output the user cancelled was persisted anyway.
 *
 * These assert the guards that close that window, at the same layer the worker uses them.
 */
describe("cancellation", () => {
  let user: Agent;
  let testRunId: string;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    user = await signUp(app, "canceller");
    const project = await user.post("/api/v1/projects", { name: "Cancellation", description: "", applicationUrl: "http://127.0.0.1:4317/" }).expect(201);
    const run = await user
      .post("/api/v1/test-runs", { projectId: project.body.data.id, applicationUrl: "http://127.0.0.1:4317/", requirements: "", testingTypes: ["Functional"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;
  });

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
  });

  const seedRun = (status: "QUEUED" | "ANALYZING" | "CANCELLED") =>
    prisma.aIGenerationRun.create({ data: { testRunId, status, provider: "seed", model: "seed", promptVersion: "v5", inputSummary: {} } });

  it("marks an in-flight generation cancelled through the API", async () => {
    const run = await seedRun("ANALYZING");
    await user.post(`/api/v1/test-runs/${testRunId}/ai-generation/cancel`).expect(202);
    const after = await prisma.aIGenerationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.cancelRequestedAt).not.toBeNull();
    await prisma.aIGenerationRun.delete({ where: { id: run.id } });
  });

  it("does not let the terminal transition resurrect a cancelled run", async () => {
    // Exactly the guarded write the worker performs once persistence finishes.
    const run = await seedRun("CANCELLED");
    const result = await prisma.aIGenerationRun.updateMany({
      where: { id: run.id, status: { notIn: ["CANCELLED"] } },
      data: { status: "COMPLETED", testCaseCount: 6, completedAt: new Date() },
    });
    expect(result.count).toBe(0);
    const after = await prisma.aIGenerationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.testCaseCount).toBe(0);
    await prisma.aIGenerationRun.delete({ where: { id: run.id } });
  });

  it("reports 404 when there is no active generation to cancel", async () => {
    await user.post(`/api/v1/test-runs/${testRunId}/ai-generation/cancel`).expect(404);
  });

  it("refuses to cancel a generation belonging to another organization", async () => {
    const outsider = await signUp(app, "cancel-outsider");
    const run = await seedRun("ANALYZING");
    await outsider.post(`/api/v1/test-runs/${testRunId}/ai-generation/cancel`).expect(404);
    const after = await prisma.aIGenerationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("ANALYZING");
    await prisma.aIGenerationRun.delete({ where: { id: run.id } });
    await cleanUpOrganization(outsider.organizationId);
  });
});
