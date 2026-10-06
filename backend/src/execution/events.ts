import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

/**
 * Progress events are persisted before they are streamed, so a client that reconnects can replay
 * from a cursor and miss nothing. Redis is not the system of record for progress.
 */
export async function recordEvent(batchId: string, type: string, payload: Record<string, unknown>, executionId?: string | null) {
  // The sequence is assigned inside a transaction against the batch's own events, which keeps
  // it gap-free per batch even with several executions running concurrently.
  return prisma.$transaction(async tx => {
    const last = await tx.executionEvent.findFirst({ where: { batchId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    return tx.executionEvent.create({
      data: { batchId, executionId: executionId ?? null, sequence: (last?.sequence ?? 0) + 1, type, payload: payload as Prisma.InputJsonValue },
    });
  });
}

export function readEvents(batchId: string, afterSequence: number, take = 200) {
  return prisma.executionEvent.findMany({ where: { batchId, sequence: { gt: afterSequence } }, orderBy: { sequence: "asc" }, take });
}
