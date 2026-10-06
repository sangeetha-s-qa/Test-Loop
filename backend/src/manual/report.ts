import { prisma } from "../db";
import { applicationTypeLabels, type ApplicationTypeKey, type ManualStatus } from "./catalog";
import { computeProgress } from "./rules";

/**
 * The manual run report. Every figure is read from stored rows - case statuses, evidence, and the
 * append-only event log - so the report says exactly what the testers recorded and nothing else.
 */
export async function buildManualReport(testRunId: string) {
  const run = await prisma.testRun.findUnique({
    where: { id: testRunId },
    include: { project: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true, email: true } }, completedBy: { select: { id: true, name: true, email: true } } },
  });
  if (!run) return null;

  const [cases, evidence, events, sessions] = await Promise.all([
    prisma.testCase.findMany({
      where: { testRunId },
      orderBy: [{ testCaseId: "asc" }],
      select: { id: true, testCaseId: true, title: true, description: true, category: true, module: true, priority: true, preconditions: true, testData: true, steps: true, expectedResult: true, actualResult: true, testerNotes: true, manualStatus: true, blockedReason: true, executedAt: true, executedBy: { select: { id: true, name: true } }, generationSource: true, bugs: { select: { id: true, reference: true, status: true, severity: true, priority: true, assignee: { select: { name: true } } }, take: 1 } },
    }),
    prisma.manualEvidence.findMany({ where: { testRunId }, orderBy: { createdAt: "asc" }, select: { id: true, testCaseId: true, kind: true, source: true, fileName: true, contentType: true, byteSize: true, pageUrl: true, createdAt: true } }),
    prisma.manualTestEvent.findMany({ where: { testRunId }, orderBy: { createdAt: "asc" }, take: 1000, select: { id: true, type: true, fromStatus: true, toStatus: true, detail: true, createdAt: true, user: { select: { name: true } }, testCase: { select: { testCaseId: true, title: true } } } }),
    prisma.manualBrowserSession.findMany({ where: { testRunId }, orderBy: { startedAt: "asc" }, select: { id: true, browser: true, status: true, startedAt: true, endedAt: true, endReason: true } }),
  ]);

  const counts: Partial<Record<ManualStatus, number>> = {};
  for (const item of cases) counts[item.manualStatus] = (counts[item.manualStatus] ?? 0) + 1;

  const byType = new Map<string, Partial<Record<ManualStatus, number>>>();
  for (const item of cases) {
    const bucket = byType.get(item.category) ?? {};
    bucket[item.manualStatus] = (bucket[item.manualStatus] ?? 0) + 1;
    byType.set(item.category, bucket);
  }

  const evidenceByCase = new Map<string, typeof evidence>();
  for (const item of evidence) {
    if (!item.testCaseId) continue;
    evidenceByCase.set(item.testCaseId, [...(evidenceByCase.get(item.testCaseId) ?? []), item]);
  }

  // Testers are the people who actually recorded verdicts, plus whoever created the run.
  const testers = new Map<string, string>();
  if (run.createdBy) testers.set(run.createdBy.id, run.createdBy.name);
  for (const item of cases) if (item.executedBy) testers.set(item.executedBy.id, item.executedBy.name);

  const settings = run.configuration as { browser?: string; viewport?: string };
  const withEvidence = (item: (typeof cases)[number]) => ({ ...item, evidence: evidenceByCase.get(item.id) ?? [] });

  return {
    final: run.status === "COMPLETED",
    run: {
      id: run.id,
      project: run.project,
      applicationUrl: run.applicationUrl,
      applicationType: run.applicationType,
      applicationTypeLabel: run.applicationType ? applicationTypeLabels[run.applicationType as ApplicationTypeKey] : null,
      testingMethod: run.testingMethod,
      testingTypes: run.testingTypes as string[],
      browser: settings.browser ?? null,
      viewport: settings.viewport ?? null,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      completedBy: run.completedBy,
      testers: [...testers.values()],
    },
    summary: computeProgress(counts),
    byType: [...byType.entries()].map(([type, bucket]) => ({ type, ...computeProgress(bucket) })).sort((a, b) => b.total - a.total),
    failed: cases.filter(item => item.manualStatus === "FAILED").map(withEvidence),
    blocked: cases.filter(item => item.manualStatus === "BLOCKED").map(withEvidence),
    cases: cases.map(item => ({ id: item.id, testCaseId: item.testCaseId, title: item.title, category: item.category, priority: item.priority, manualStatus: item.manualStatus, executedAt: item.executedAt, executedBy: item.executedBy?.name ?? null, evidenceCount: evidenceByCase.get(item.id)?.length ?? 0 })),
    evidenceCount: evidence.length,
    sessions,
    timeline: events.map(event => ({ id: event.id, type: event.type, fromStatus: event.fromStatus, toStatus: event.toStatus, detail: event.detail, createdAt: event.createdAt, user: event.user?.name ?? null, testCase: event.testCase })),
  };
}

export type ManualReport = NonNullable<Awaited<ReturnType<typeof buildManualReport>>>;
