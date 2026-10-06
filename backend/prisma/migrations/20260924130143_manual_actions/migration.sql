-- CreateEnum
CREATE TYPE "ManualActionReason" AS ENUM ('OTP', 'CAPTCHA', 'EMAIL_VERIFICATION', 'EXTERNAL_AUTH', 'PAYMENT_CONFIRMATION', 'FILE_UPLOAD', 'USER_APPROVAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ManualActionStatus" AS ENUM ('PENDING', 'RESOLVED', 'EXPIRED', 'ABORTED');

-- AlterEnum
ALTER TYPE "ExecutionStatus" ADD VALUE 'WAITING_FOR_USER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FailureCategory" ADD VALUE 'MANUAL_ACTION_EXPIRED';
ALTER TYPE "FailureCategory" ADD VALUE 'MANUAL_ACTION_ABORTED';

-- AlterEnum
ALTER TYPE "TestRunStatus" ADD VALUE 'WAITING_FOR_USER';

-- CreateTable
CREATE TABLE "ManualAction" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "reason" "ManualActionReason" NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "ManualActionStatus" NOT NULL DEFAULT 'PENDING',
    "pageUrl" TEXT,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "extensionCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualAction_projectId_status_idx" ON "ManualAction"("projectId", "status");

-- CreateIndex
CREATE INDEX "ManualAction_testRunId_status_idx" ON "ManualAction"("testRunId", "status");

-- CreateIndex
CREATE INDEX "ManualAction_status_deadlineAt_idx" ON "ManualAction"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "ManualAction_executionId_stepIndex_key" ON "ManualAction"("executionId", "stepIndex");

-- AddForeignKey
ALTER TABLE "ManualAction" ADD CONSTRAINT "ManualAction_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualAction" ADD CONSTRAINT "ManualAction_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualAction" ADD CONSTRAINT "ManualAction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualAction" ADD CONSTRAINT "ManualAction_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
