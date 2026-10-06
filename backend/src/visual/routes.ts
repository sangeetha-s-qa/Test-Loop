import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { artifactContentTypes, buildStorageKey, getObject, putObject } from "../artifacts/storage";
import { prisma } from "../db";
import { canApprove, canWrite, conflict, forbidden, notFound, route, registerUuidParams } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { compareScreenshots, parseMasks } from "./compare";

export const visualRouter = Router();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(visualRouter);

const maskSchema = z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) })).max(50);

const compareSchema = z.object({
  screenshotArtifactId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).default("default"),
  threshold: z.number().min(0).max(1).optional(),
  environment: z.string().trim().min(1).max(80).default("default"),
  masks: maskSchema.optional(),
});

/**
 * POST /api/v1/executions/:id/visual-comparisons — compare a captured screenshot to the
 * approved baseline for the same test case, browser, viewport, scale, and environment.
 *
 * When no baseline exists the result is NEW_BASELINE_REQUIRED. Nothing is auto-approved.
 */
visualRouter.post("/executions/:id/visual-comparisons", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Running visual comparisons is not permitted for your role");
  const input = compareSchema.parse(request.body ?? {});

  const execution = await prisma.testExecution.findFirst({
    where: { id: request.params.id, project: { organizationId: user.organizationId } },
    include: { testRun: { select: { configuration: true } } },
  });
  if (!execution) return notFound(response, "Execution not found");

  const current = await prisma.executionArtifact.findFirst({ where: { id: input.screenshotArtifactId, executionId: execution.id, type: "SCREENSHOT" } });
  if (!current) return notFound(response, "Screenshot artifact not found for this execution");

  const viewport = execution.viewport as { width: number; height: number };
  const settings = execution.testRun.configuration as { visualThreshold?: number };
  const threshold = input.threshold ?? (typeof settings.visualThreshold === "number" ? settings.visualThreshold : 0.01);

  const identity = { testCaseId: execution.testCaseId, name: input.name, browser: execution.browser, viewportWidth: viewport.width, viewportHeight: viewport.height, deviceScaleFactor: 1, environment: input.environment };
  const baseline = await prisma.visualBaseline.upsert({
    where: { testCaseId_name_browser_viewportWidth_viewportHeight_deviceScaleFactor_environment: identity },
    update: {},
    create: { ...identity, projectId: execution.projectId },
    include: { approvedVersion: { include: { artifact: true } } },
  });

  const masks = input.masks ?? parseMasks(baseline.approvedVersion?.masks);

  if (!baseline.approvedVersion) {
    const comparison = await prisma.visualComparison.create({
      data: { executionId: execution.id, baselineId: baseline.id, currentArtifactId: current.id, status: "NEW_BASELINE_REQUIRED", threshold, masks: masks as unknown as Prisma.InputJsonValue },
    });
    return response.status(201).json({ data: comparison, message: "No approved baseline exists yet. Review this capture and approve it to create the first baseline." });
  }

  const [baselineBytes, currentBytes] = await Promise.all([getObject(baseline.approvedVersion.artifact.storageKey), getObject(current.storageKey)]);
  const result = compareScreenshots(baselineBytes, currentBytes, { threshold, masks });

  let diffArtifactId: string | null = null;
  if (result.diffPng) {
    const fileName = `visual-diff-${baseline.id.slice(0, 8)}-${Date.now()}.png`;
    const storageKey = buildStorageKey({ organizationId: user.organizationId, projectId: execution.projectId, executionId: execution.id, type: "visual_diff", fileName });
    const stored = await putObject(storageKey, result.diffPng);
    const artifact = await prisma.executionArtifact.create({
      data: { executionId: execution.id, type: "VISUAL_DIFF", storageKey: stored.storageKey, fileName, contentType: artifactContentTypes.VISUAL_DIFF, byteSize: stored.byteSize, checksumSha256: stored.checksumSha256 },
    });
    diffArtifactId = artifact.id;
  }

  const comparison = await prisma.visualComparison.create({
    data: {
      executionId: execution.id,
      baselineId: baseline.id,
      baselineVersionId: baseline.approvedVersion.id,
      baselineArtifactId: baseline.approvedVersion.artifactId,
      currentArtifactId: current.id,
      diffArtifactId,
      // A measured difference stays DIFFERENT until a person acts on it.
      status: result.matched ? "MATCHED" : "DIFFERENT",
      threshold,
      diffPixelCount: result.diffPixelCount,
      totalPixelCount: result.totalPixelCount,
      diffRatio: result.diffRatio,
      dimensionsMatch: result.dimensionsMatch,
      masks: masks as unknown as Prisma.InputJsonValue,
    },
  });
  return response.status(201).json({ data: comparison });
}));

/** GET /api/v1/executions/:id/visual-comparisons — comparisons recorded for one execution. */
visualRouter.get("/executions/:id/visual-comparisons", requireAuth, route(async (request: AuthRequest, response) => {
  const execution = await prisma.testExecution.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } });
  if (!execution) return notFound(response, "Execution not found");
  const comparisons = await prisma.visualComparison.findMany({
    where: { executionId: execution.id },
    include: { baseline: { select: { id: true, name: true, browser: true, viewportWidth: true, viewportHeight: true, environment: true } } },
    orderBy: { createdAt: "desc" },
  });
  return response.json({ data: comparisons });
}));

/**
 * POST /api/v1/visual-comparisons/:id/approve — accept the current capture as the new baseline.
 * This always creates a NEW immutable VisualBaselineVersion; history is never overwritten.
 */
visualRouter.post("/visual-comparisons/:id/approve", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canApprove(user.role)) return forbidden(response, "Approving baselines is not permitted for your role");

  const comparison = await prisma.visualComparison.findFirst({ where: { id: request.params.id, execution: { project: { organizationId: user.organizationId } } } });
  if (!comparison) return notFound(response, "Visual comparison not found");
  if (!["DIFFERENT", "NEW_BASELINE_REQUIRED"].includes(comparison.status)) return conflict(response, "NOTHING_TO_APPROVE", `A comparison with status ${comparison.status} does not need a new baseline`);

  const result = await prisma.$transaction(async tx => {
    const baseline = await tx.visualBaseline.update({ where: { id: comparison.baselineId }, data: { latestVersion: { increment: 1 } } });
    const version = await tx.visualBaselineVersion.create({
      data: { baselineId: baseline.id, version: baseline.latestVersion, artifactId: comparison.currentArtifactId, masks: comparison.masks as Prisma.InputJsonValue, approvedById: user.id },
    });
    // The pointer moves; the previous version row stays exactly as it was.
    await tx.visualBaseline.update({ where: { id: baseline.id }, data: { approvedVersionId: version.id } });
    await tx.visualComparison.update({ where: { id: comparison.id }, data: { status: "APPROVED", reviewedById: user.id, reviewedAt: new Date() } });
    return version;
  });
  return response.status(201).json({ data: result });
}));

visualRouter.post("/visual-comparisons/:id/reject", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canApprove(user.role)) return forbidden(response, "Rejecting comparisons is not permitted for your role");
  const result = await prisma.visualComparison.updateMany({
    where: { id: request.params.id, status: { in: ["DIFFERENT", "NEW_BASELINE_REQUIRED"] }, execution: { project: { organizationId: user.organizationId } } },
    data: { status: "REJECTED", reviewedById: user.id, reviewedAt: new Date() },
  });
  if (!result.count) return notFound(response, "Reviewable visual comparison not found");
  return response.json({ data: { id: request.params.id, status: "REJECTED" } });
}));

/** GET /api/v1/test-cases/:id/visual-baselines — baselines and their full approval history. */
visualRouter.get("/test-cases/:id/visual-baselines", requireAuth, route(async (request: AuthRequest, response) => {
  const testCase = await prisma.testCase.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, select: { id: true } });
  if (!testCase) return notFound(response, "Test case not found");
  const baselines = await prisma.visualBaseline.findMany({
    where: { testCaseId: testCase.id },
    include: { versions: { orderBy: { version: "desc" }, include: { artifact: { select: { id: true, fileName: true, byteSize: true } } } } },
    orderBy: { updatedAt: "desc" },
  });
  return response.json({ data: baselines });
}));
