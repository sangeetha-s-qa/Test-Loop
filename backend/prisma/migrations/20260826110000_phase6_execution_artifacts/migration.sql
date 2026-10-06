-- CreateEnum
CREATE TYPE "ExecutionBatchStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'PROVISIONING', 'RUNNING', 'COLLECTING_ARTIFACTS', 'PASSED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'ERRORED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('SCREENSHOT', 'VIDEO', 'TRACE', 'HAR', 'CONSOLE_LOG', 'NETWORK_LOG', 'VISUAL_DIFF', 'REPORT');

-- CreateEnum
CREATE TYPE "FailureCategory" AS ENUM ('ASSERTION_FAILED', 'LOCATOR_NOT_FOUND', 'LOCATOR_AMBIGUOUS', 'TIMEOUT', 'NAVIGATION_FAILED', 'CONSOLE_ERROR', 'POLICY_VIOLATION', 'INFRASTRUCTURE', 'CANCELLED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ExecutionBatch" (
    "id" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "status" "ExecutionBatchStatus" NOT NULL DEFAULT 'QUEUED',
    "browser" TEXT NOT NULL,
    "viewport" JSONB NOT NULL,
    "requestedCount" INTEGER NOT NULL DEFAULT 0,
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "erroredCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestExecution" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "testCaseId" UUID NOT NULL,
    "scenarioId" UUID,
    "automationVersionId" UUID NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "browser" TEXT NOT NULL,
    "browserVersion" TEXT,
    "viewport" JSONB NOT NULL,
    "applicationUrl" TEXT NOT NULL,
    "totalSteps" INTEGER NOT NULL DEFAULT 0,
    "passedSteps" INTEGER NOT NULL DEFAULT 0,
    "failedStepIndex" INTEGER,
    "failureCategory" "FailureCategory",
    "failureMessage" TEXT,
    "consoleErrorCount" INTEGER NOT NULL DEFAULT 0,
    "networkFailureCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestStepResult" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "locator" JSONB,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "failureCategory" "FailureCategory",
    "failureMessage" TEXT,
    "pageUrl" TEXT,
    "domEvidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestStepResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionArtifact" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "stepResultId" UUID,
    "type" "ArtifactType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionEvent" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "executionId" UUID,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutionBatch_testRunId_createdAt_idx" ON "ExecutionBatch"("testRunId", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionBatch_testRunId_status_idx" ON "ExecutionBatch"("testRunId", "status");

-- CreateIndex
CREATE INDEX "TestExecution_testRunId_status_idx" ON "TestExecution"("testRunId", "status");

-- CreateIndex
CREATE INDEX "TestExecution_projectId_createdAt_idx" ON "TestExecution"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "TestExecution_testCaseId_createdAt_idx" ON "TestExecution"("testCaseId", "createdAt");

-- CreateIndex
CREATE INDEX "TestExecution_automationVersionId_idx" ON "TestExecution"("automationVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "TestExecution_batchId_testCaseId_attempt_key" ON "TestExecution"("batchId", "testCaseId", "attempt");

-- CreateIndex
CREATE INDEX "TestStepResult_executionId_status_idx" ON "TestStepResult"("executionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TestStepResult_executionId_stepIndex_key" ON "TestStepResult"("executionId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionArtifact_storageKey_key" ON "ExecutionArtifact"("storageKey");

-- CreateIndex
CREATE INDEX "ExecutionArtifact_executionId_type_idx" ON "ExecutionArtifact"("executionId", "type");

-- CreateIndex
CREATE INDEX "ExecutionEvent_batchId_sequence_idx" ON "ExecutionEvent"("batchId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionEvent_batchId_sequence_key" ON "ExecutionEvent"("batchId", "sequence");

-- AddForeignKey
ALTER TABLE "HealingProposal" ADD CONSTRAINT "HealingProposal_stepExecutionId_fkey" FOREIGN KEY ("stepExecutionId") REFERENCES "TestStepResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionBatch" ADD CONSTRAINT "ExecutionBatch_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionBatch" ADD CONSTRAINT "ExecutionBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ExecutionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "TestScenario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_automationVersionId_fkey" FOREIGN KEY ("automationVersionId") REFERENCES "AutomationVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestStepResult" ADD CONSTRAINT "TestStepResult_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionArtifact" ADD CONSTRAINT "ExecutionArtifact_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionArtifact" ADD CONSTRAINT "ExecutionArtifact_stepResultId_fkey" FOREIGN KEY ("stepResultId") REFERENCES "TestStepResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ExecutionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

