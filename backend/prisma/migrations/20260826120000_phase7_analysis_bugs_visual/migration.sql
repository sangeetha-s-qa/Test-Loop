-- CreateEnum
CREATE TYPE "FailureAnalysisStatus" AS ENUM ('QUEUED', 'ANALYZING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BugStatus" AS ENUM ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "BugSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "VisualComparisonStatus" AS ENUM ('PENDING', 'MATCHED', 'DIFFERENT', 'NEW_BASELINE_REQUIRED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "FailureAnalysis" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "FailureAnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "category" TEXT,
    "likelyCause" TEXT,
    "recommendedAction" TEXT,
    "summary" TEXT,
    "confidence" DOUBLE PRECISION,
    "evidenceRefs" JSONB NOT NULL,
    "rawOutput" JSONB,
    "error" TEXT,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailureAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bug" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "testCaseId" UUID,
    "executionId" UUID,
    "analysisId" UUID,
    "reference" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "stepsToReproduce" JSONB NOT NULL,
    "expectedBehavior" TEXT NOT NULL,
    "actualBehavior" TEXT NOT NULL,
    "severity" "BugSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "BugStatus" NOT NULL DEFAULT 'OPEN',
    "fingerprint" TEXT NOT NULL,
    "duplicateOfId" UUID,
    "reportedById" UUID,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bug_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualBaseline" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "testCaseId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "viewportWidth" INTEGER NOT NULL,
    "viewportHeight" INTEGER NOT NULL,
    "deviceScaleFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "environment" TEXT NOT NULL DEFAULT 'default',
    "approvedVersionId" UUID,
    "latestVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualBaselineVersion" (
    "id" UUID NOT NULL,
    "baselineId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "artifactId" UUID NOT NULL,
    "masks" JSONB NOT NULL,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualBaselineVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualComparison" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "baselineId" UUID NOT NULL,
    "baselineVersionId" UUID,
    "baselineArtifactId" UUID,
    "currentArtifactId" UUID NOT NULL,
    "diffArtifactId" UUID,
    "status" "VisualComparisonStatus" NOT NULL DEFAULT 'PENDING',
    "algorithm" TEXT NOT NULL DEFAULT 'pixelmatch',
    "threshold" DOUBLE PRECISION NOT NULL,
    "diffPixelCount" INTEGER,
    "totalPixelCount" INTEGER,
    "diffRatio" DOUBLE PRECISION,
    "dimensionsMatch" BOOLEAN NOT NULL DEFAULT true,
    "masks" JSONB NOT NULL,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualComparison_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailureAnalysis_executionId_status_idx" ON "FailureAnalysis"("executionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FailureAnalysis_executionId_version_key" ON "FailureAnalysis"("executionId", "version");

-- CreateIndex
CREATE INDEX "Bug_projectId_status_severity_idx" ON "Bug"("projectId", "status", "severity");

-- CreateIndex
CREATE INDEX "Bug_testCaseId_idx" ON "Bug"("testCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Bug_projectId_fingerprint_key" ON "Bug"("projectId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Bug_projectId_reference_key" ON "Bug"("projectId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaseline_approvedVersionId_key" ON "VisualBaseline"("approvedVersionId");

-- CreateIndex
CREATE INDEX "VisualBaseline_projectId_updatedAt_idx" ON "VisualBaseline"("projectId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaseline_testCaseId_name_browser_viewportWidth_viewpo_key" ON "VisualBaseline"("testCaseId", "name", "browser", "viewportWidth", "viewportHeight", "deviceScaleFactor", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "VisualBaselineVersion_baselineId_version_key" ON "VisualBaselineVersion"("baselineId", "version");

-- CreateIndex
CREATE INDEX "VisualComparison_executionId_idx" ON "VisualComparison"("executionId");

-- CreateIndex
CREATE INDEX "VisualComparison_baselineId_createdAt_idx" ON "VisualComparison"("baselineId", "createdAt");

-- CreateIndex
CREATE INDEX "VisualComparison_status_createdAt_idx" ON "VisualComparison"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "FailureAnalysis" ADD CONSTRAINT "FailureAnalysis_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "FailureAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Bug"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaseline" ADD CONSTRAINT "VisualBaseline_approvedVersionId_fkey" FOREIGN KEY ("approvedVersionId") REFERENCES "VisualBaselineVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaselineVersion" ADD CONSTRAINT "VisualBaselineVersion_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "VisualBaseline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaselineVersion" ADD CONSTRAINT "VisualBaselineVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ExecutionArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualBaselineVersion" ADD CONSTRAINT "VisualBaselineVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualComparison" ADD CONSTRAINT "VisualComparison_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualComparison" ADD CONSTRAINT "VisualComparison_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "VisualBaseline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualComparison" ADD CONSTRAINT "VisualComparison_baselineVersionId_fkey" FOREIGN KEY ("baselineVersionId") REFERENCES "VisualBaselineVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualComparison" ADD CONSTRAINT "VisualComparison_baselineArtifactId_fkey" FOREIGN KEY ("baselineArtifactId") REFERENCES "ExecutionArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualComparison" ADD CONSTRAINT "VisualComparison_currentArtifactId_fkey" FOREIGN KEY ("currentArtifactId") REFERENCES "ExecutionArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualComparison" ADD CONSTRAINT "VisualComparison_diffArtifactId_fkey" FOREIGN KEY ("diffArtifactId") REFERENCES "ExecutionArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualComparison" ADD CONSTRAINT "VisualComparison_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

