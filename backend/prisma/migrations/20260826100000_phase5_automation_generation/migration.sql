-- CreateEnum
CREATE TYPE "TestCaseVersionSource" AS ENUM ('AI', 'USER_EDIT');

-- CreateEnum
CREATE TYPE "AutomationGenerationStatus" AS ENUM ('QUEUED', 'GENERATING', 'VALIDATING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutomationVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AutomationVersionSource" AS ENUM ('AI', 'USER_EDIT', 'HEALING');

-- CreateEnum
CREATE TYPE "AutomationValidationStatus" AS ENUM ('PASSED', 'PASSED_WITH_WARNINGS', 'FAILED');

-- CreateEnum
CREATE TYPE "HealingProposalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "currentVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TestCaseVersion" (
    "id" UUID NOT NULL,
    "testCaseId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "preconditions" TEXT NOT NULL,
    "testData" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "expectedResult" TEXT NOT NULL,
    "postconditions" TEXT NOT NULL,
    "source" "TestCaseVersionSource" NOT NULL DEFAULT 'AI',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestCaseVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationScript" (
    "id" UUID NOT NULL,
    "testCaseId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "framework" TEXT NOT NULL DEFAULT 'playwright',
    "language" TEXT NOT NULL DEFAULT 'typescript',
    "approvedVersionId" UUID,
    "latestVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationVersion" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "testCaseVersionId" UUID NOT NULL,
    "generationRunId" UUID,
    "program" JSONB NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "programSchemaVersion" TEXT NOT NULL DEFAULT 'v1',
    "status" "AutomationVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "source" "AutomationVersionSource" NOT NULL DEFAULT 'AI',
    "validationStatus" "AutomationValidationStatus" NOT NULL,
    "validationIssues" JSONB NOT NULL,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "assertionCount" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "healedFromVersionId" UUID,
    "approvedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationGenerationRun" (
    "id" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "status" "AutomationGenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestedCount" INTEGER NOT NULL DEFAULT 0,
    "generatedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationGenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealingProposal" (
    "id" UUID NOT NULL,
    "scriptId" UUID NOT NULL,
    "automationVersionId" UUID NOT NULL,
    "stepExecutionId" UUID,
    "stepIndex" INTEGER NOT NULL,
    "failedLocator" JSONB NOT NULL,
    "proposedLocator" JSONB NOT NULL,
    "candidates" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "HealingProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "provider" TEXT,
    "model" TEXT,
    "resultingVersionId" UUID,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealingProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestCaseVersion_testCaseId_createdAt_idx" ON "TestCaseVersion"("testCaseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TestCaseVersion_testCaseId_version_key" ON "TestCaseVersion"("testCaseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationScript_testCaseId_key" ON "AutomationScript"("testCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationScript_approvedVersionId_key" ON "AutomationScript"("approvedVersionId");

-- CreateIndex
CREATE INDEX "AutomationScript_projectId_updatedAt_idx" ON "AutomationScript"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "AutomationVersion_scriptId_status_idx" ON "AutomationVersion"("scriptId", "status");

-- CreateIndex
CREATE INDEX "AutomationVersion_generationRunId_idx" ON "AutomationVersion"("generationRunId");

-- CreateIndex
CREATE INDEX "AutomationVersion_testCaseVersionId_idx" ON "AutomationVersion"("testCaseVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationVersion_scriptId_version_key" ON "AutomationVersion"("scriptId", "version");

-- CreateIndex
CREATE INDEX "AutomationGenerationRun_testRunId_createdAt_idx" ON "AutomationGenerationRun"("testRunId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationGenerationRun_testRunId_status_idx" ON "AutomationGenerationRun"("testRunId", "status");

-- CreateIndex
CREATE INDEX "HealingProposal_scriptId_status_idx" ON "HealingProposal"("scriptId", "status");

-- CreateIndex
CREATE INDEX "HealingProposal_automationVersionId_idx" ON "HealingProposal"("automationVersionId");

-- AddForeignKey
ALTER TABLE "TestCaseVersion" ADD CONSTRAINT "TestCaseVersion_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseVersion" ADD CONSTRAINT "TestCaseVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationScript" ADD CONSTRAINT "AutomationScript_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationScript" ADD CONSTRAINT "AutomationScript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationScript" ADD CONSTRAINT "AutomationScript_approvedVersionId_fkey" FOREIGN KEY ("approvedVersionId") REFERENCES "AutomationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationVersion" ADD CONSTRAINT "AutomationVersion_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "AutomationScript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationVersion" ADD CONSTRAINT "AutomationVersion_testCaseVersionId_fkey" FOREIGN KEY ("testCaseVersionId") REFERENCES "TestCaseVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationVersion" ADD CONSTRAINT "AutomationVersion_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "AutomationGenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationVersion" ADD CONSTRAINT "AutomationVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationGenerationRun" ADD CONSTRAINT "AutomationGenerationRun_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealingProposal" ADD CONSTRAINT "HealingProposal_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "AutomationScript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealingProposal" ADD CONSTRAINT "HealingProposal_automationVersionId_fkey" FOREIGN KEY ("automationVersionId") REFERENCES "AutomationVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealingProposal" ADD CONSTRAINT "HealingProposal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

