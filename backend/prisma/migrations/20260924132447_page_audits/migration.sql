-- CreateEnum
CREATE TYPE "AuditAnalyzer" AS ENUM ('ACCESSIBILITY', 'PERFORMANCE', 'SECURITY');

-- CreateEnum
CREATE TYPE "AuditRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditPageStatus" AS ENUM ('PASSED', 'PASSED_WITH_WARNINGS', 'FAILED', 'ERRORED');

-- CreateEnum
CREATE TYPE "AuditImpact" AS ENUM ('CRITICAL', 'SERIOUS', 'MODERATE', 'MINOR', 'INFO');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "egressAllowlist" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "AuditRun" (
    "id" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "AuditRunStatus" NOT NULL DEFAULT 'QUEUED',
    "jobId" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "browser" TEXT NOT NULL,
    "viewport" JSONB NOT NULL,
    "pagesRequested" INTEGER NOT NULL DEFAULT 0,
    "pagesCompleted" INTEGER NOT NULL DEFAULT 0,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageAudit" (
    "id" UUID NOT NULL,
    "auditRunId" UUID NOT NULL,
    "pageId" UUID,
    "url" TEXT NOT NULL,
    "analyzer" "AuditAnalyzer" NOT NULL,
    "status" "AuditPageStatus" NOT NULL,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" UUID NOT NULL,
    "pageAuditId" UUID NOT NULL,
    "ruleId" TEXT NOT NULL,
    "impact" "AuditImpact" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "selector" TEXT,
    "snippet" TEXT,
    "helpUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceSample" (
    "id" UUID NOT NULL,
    "pageAuditId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditRun_jobId_key" ON "AuditRun"("jobId");

-- CreateIndex
CREATE INDEX "AuditRun_testRunId_createdAt_idx" ON "AuditRun"("testRunId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditRun_projectId_status_idx" ON "AuditRun"("projectId", "status");

-- CreateIndex
CREATE INDEX "PageAudit_auditRunId_analyzer_status_idx" ON "PageAudit"("auditRunId", "analyzer", "status");

-- CreateIndex
CREATE INDEX "PageAudit_pageId_idx" ON "PageAudit"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "PageAudit_auditRunId_url_analyzer_key" ON "PageAudit"("auditRunId", "url", "analyzer");

-- CreateIndex
CREATE INDEX "AuditFinding_pageAuditId_impact_idx" ON "AuditFinding"("pageAuditId", "impact");

-- CreateIndex
CREATE INDEX "AuditFinding_ruleId_idx" ON "AuditFinding"("ruleId");

-- CreateIndex
CREATE INDEX "PerformanceSample_metric_idx" ON "PerformanceSample"("metric");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceSample_pageAuditId_metric_key" ON "PerformanceSample"("pageAuditId", "metric");

-- AddForeignKey
ALTER TABLE "AuditRun" ADD CONSTRAINT "AuditRun_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditRun" ADD CONSTRAINT "AuditRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageAudit" ADD CONSTRAINT "PageAudit_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "AuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageAudit" ADD CONSTRAINT "PageAudit_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "DiscoveredPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditFinding" ADD CONSTRAINT "AuditFinding_pageAuditId_fkey" FOREIGN KEY ("pageAuditId") REFERENCES "PageAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceSample" ADD CONSTRAINT "PerformanceSample_pageAuditId_fkey" FOREIGN KEY ("pageAuditId") REFERENCES "PageAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
