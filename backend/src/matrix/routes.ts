import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { canWrite, conflict, forbidden, notFound, registerUuidParams, route } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { createMatrixRun, MatrixError, readMatrixRun } from "./service";

export const matrixRouter = Router();
registerUuidParams(matrixRouter);

const startSchema = z.object({
  browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).min(1).max(3),
  viewports: z.array(z.enum(["desktop", "tablet", "mobile"])).min(1).max(3),
  testCaseIds: z.array(z.string().uuid()).max(500).optional(),
});

/**
 * POST /api/v1/test-runs/:id/matrix — replay the approved automation across browser x viewport.
 *
 * The first browser and the first viewport become the baseline every other cell is compared to,
 * so the order in the request is meaningful rather than incidental.
 */
matrixRouter.post("/test-runs/:id/matrix", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Starting a matrix replay is not permitted for your role");

  const input = startSchema.parse(request.body ?? {});
  try {
    const matrixRun = await createMatrixRun({
      testRunId: request.params.id,
      organizationId: user.organizationId,
      userId: user.id,
      // De-duplicated so "chromium, chromium" cannot silently double the cost of a run.
      browsers: [...new Set(input.browsers)],
      viewports: [...new Set(input.viewports)],
      testCaseIds: input.testCaseIds,
    });
    return response.status(202).json({ data: matrixRun });
  } catch (error) {
    if (error instanceof MatrixError) {
      return error.code === "NOT_FOUND" ? notFound(response, error.message) : conflict(response, error.code, error.message);
    }
    throw error;
  }
}));

/** GET /api/v1/test-runs/:id/matrix — matrix replays for a test run, newest first. */
matrixRouter.get("/test-runs/:id/matrix", requireAuth, route(async (request: AuthRequest, response) => {
  const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } });
  if (!testRun) return notFound(response, "Test run not found");
  const runs = await prisma.matrixRun.findMany({ where: { testRunId: testRun.id }, orderBy: { createdAt: "desc" }, take: 20 });
  return response.json({ data: runs });
}));

/** GET /api/v1/matrix/:id — the grid, the per-cell totals, and the rows whose result differs. */
matrixRouter.get("/matrix/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const matrixRun = await readMatrixRun(request.params.id, request.user!.organizationId);
  if (!matrixRun) return notFound(response, "Matrix replay not found");
  return response.json({ data: matrixRun });
}));

/**
 * POST /api/v1/matrix/:id/cancel — stops every cell that has not finished.
 *
 * Cells already settled keep their results: a partial matrix is still evidence about the cells that
 * ran, and discarding it would throw away real browser time.
 */
matrixRouter.post("/matrix/:id/cancel", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Cancelling a matrix replay is not permitted for your role");

  const matrixRun = await prisma.matrixRun.findFirst({
    where: { id: request.params.id, project: { organizationId: user.organizationId }, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true, cells: { select: { batchId: true } } },
  });
  if (!matrixRun) return notFound(response, "No matrix replay in progress for this id");

  await prisma.executionBatch.updateMany({
    where: { id: { in: matrixRun.cells.map(cell => cell.batchId) }, status: { in: ["QUEUED", "RUNNING"] } },
    data: { cancelRequestedAt: new Date() },
  });
  await prisma.matrixRun.update({ where: { id: matrixRun.id }, data: { status: "CANCELLED", completedAt: new Date() } });
  return response.status(202).json({ data: { id: matrixRun.id, status: "CANCELLED" } });
}));
