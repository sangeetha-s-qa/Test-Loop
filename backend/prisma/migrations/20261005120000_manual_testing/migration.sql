-- CreateEnum
CREATE TYPE "TestingMethod" AS ENUM ('AUTOMATED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ApplicationType" AS ENUM ('ECOMMERCE', 'BANKING_FINTECH', 'HEALTHCARE', 'EDUCATION', 'SOCIAL_MEDIA', 'SAAS', 'BOOKING', 'LOGISTICS', 'REAL_ESTATE', 'ERP', 'CONTENT_MEDIA', 'GAMING', 'ADMIN_PORTAL', 'BUSINESS_CORPORATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ManualTestStatus" AS ENUM ('NOT_RUN', 'IN_PROGRESS', 'PASSED', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ManualBlockedReason" AS ENUM ('ENVIRONMENT_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'APPLICATION_UNAVAILABLE', 'TEST_DATA_UNAVAILABLE', 'BROWSER_ISSUE', 'EXTERNAL_DEPENDENCY_UNAVAILABLE', 'OTHER');

-- CreateEnum
CREATE TYPE "ManualEvidenceKind" AS ENUM ('SCREENSHOT', 'VIDEO');

-- CreateEnum
CREATE TYPE "ManualEvidenceSource" AS ENUM ('BROWSER_CAPTURE', 'AUTO_ON_FAIL', 'UPLOAD');

-- CreateEnum
CREATE TYPE "ManualSessionStatus" AS ENUM ('STARTING', 'ACTIVE', 'CLOSED', 'CRASHED', 'FAILED');

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "actualResult" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "blockedReason" "ManualBlockedReason",
ADD COLUMN     "executedAt" TIMESTAMP(3),
ADD COLUMN     "executedById" UUID,
ADD COLUMN     "manualStatus" "ManualTestStatus" NOT NULL DEFAULT 'NOT_RUN',
ADD COLUMN     "testerNotes" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "TestRun" ADD COLUMN     "applicationType" "ApplicationType",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedById" UUID,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "testingMethod" "TestingMethod" NOT NULL DEFAULT 'AUTOMATED';

-- CreateTable
CREATE TABLE "ManualEvidence" (
    "id" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "testCaseId" UUID,
    "kind" "ManualEvidenceKind" NOT NULL DEFAULT 'SCREENSHOT',
    "source" "ManualEvidenceSource" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "pageUrl" TEXT,
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualBrowserSession" (
    "id" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "startedById" UUID,
    "browser" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "status" "ManualSessionStatus" NOT NULL DEFAULT 'STARTING',
    "lastError" TEXT,
    "endReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "ManualBrowserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualTestEvent" (
    "id" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "testCaseId" UUID,
    "userId" UUID,
    "type" TEXT NOT NULL,
    "fromStatus" "ManualTestStatus",
    "toStatus" "ManualTestStatus",
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualTestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualEvidence_storageKey_key" ON "ManualEvidence"("storageKey");

-- CreateIndex
CREATE INDEX "ManualEvidence_testRunId_testCaseId_createdAt_idx" ON "ManualEvidence"("testRunId", "testCaseId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualEvidence_projectId_createdAt_idx" ON "ManualEvidence"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualBrowserSession_testRunId_status_idx" ON "ManualBrowserSession"("testRunId", "status");

-- CreateIndex
CREATE INDEX "ManualBrowserSession_status_idx" ON "ManualBrowserSession"("status");

-- CreateIndex
CREATE INDEX "ManualTestEvent_testRunId_createdAt_idx" ON "ManualTestEvent"("testRunId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualTestEvent_testCaseId_createdAt_idx" ON "ManualTestEvent"("testCaseId", "createdAt");

-- CreateIndex
CREATE INDEX "TestCase_testRunId_manualStatus_idx" ON "TestCase"("testRunId", "manualStatus");

-- CreateIndex
CREATE INDEX "TestRun_projectId_testingMethod_idx" ON "TestRun"("projectId", "testingMethod");

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualEvidence" ADD CONSTRAINT "ManualEvidence_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualEvidence" ADD CONSTRAINT "ManualEvidence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualEvidence" ADD CONSTRAINT "ManualEvidence_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualEvidence" ADD CONSTRAINT "ManualEvidence_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBrowserSession" ADD CONSTRAINT "ManualBrowserSession_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBrowserSession" ADD CONSTRAINT "ManualBrowserSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBrowserSession" ADD CONSTRAINT "ManualBrowserSession_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTestEvent" ADD CONSTRAINT "ManualTestEvent_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTestEvent" ADD CONSTRAINT "ManualTestEvent_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTestEvent" ADD CONSTRAINT "ManualTestEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

