-- CreateEnum
CREATE TYPE "BugPriority" AS ENUM ('P1', 'P2', 'P3', 'P4');

-- CreateEnum
CREATE TYPE "BugSource" AS ENUM ('AUTOMATED', 'MANUAL');

-- CreateEnum
CREATE TYPE "TeamFunction" AS ENUM ('QA', 'DEVELOPER', 'PRODUCT', 'DESIGN', 'OTHER');

-- CreateEnum
CREATE TYPE "BugEventType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'SEVERITY_CHANGED', 'PRIORITY_CHANGED', 'DUE_DATE_CHANGED', 'COMMENTED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BUG_ASSIGNED', 'BUG_STATUS_CHANGED', 'BUG_COMMENTED', 'BUG_READY_FOR_RETEST', 'BUG_REOPENED');

-- AlterEnum
BEGIN;
CREATE TYPE "BugStatus_new" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'FIXED', 'READY_FOR_RETEST', 'VERIFIED', 'CLOSED', 'REOPENED', 'REJECTED', 'DEFERRED', 'DUPLICATE');
ALTER TABLE "public"."Bug" ALTER COLUMN "status" DROP DEFAULT;
-- Existing bugs move onto the new lifecycle: OPEN and TRIAGED were never assigned, so they are NEW;
-- RESOLVED meant "a fix exists", which is FIXED. Everything else keeps its name.
ALTER TABLE "Bug" ALTER COLUMN "status" TYPE "BugStatus_new" USING (
  CASE "status"::text
    WHEN 'OPEN' THEN 'NEW'
    WHEN 'TRIAGED' THEN 'NEW'
    WHEN 'RESOLVED' THEN 'FIXED'
    ELSE "status"::text
  END
)::"BugStatus_new";
ALTER TYPE "BugStatus" RENAME TO "BugStatus_old";
ALTER TYPE "BugStatus_new" RENAME TO "BugStatus";
DROP TYPE "public"."BugStatus_old";
ALTER TABLE "Bug" ALTER COLUMN "status" SET DEFAULT 'NEW';
COMMIT;

-- AlterTable
ALTER TABLE "Bug" ADD COLUMN     "assigneeId" UUID,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "fixedAt" TIMESTAMP(3),
ADD COLUMN     "priority" "BugPriority" NOT NULL DEFAULT 'P3',
ADD COLUMN     "reopenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "source" "BugSource" NOT NULL DEFAULT 'AUTOMATED',
ADD COLUMN     "testRunId" UUID,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ALTER COLUMN "status" SET DEFAULT 'NEW';

-- AlterTable
ALTER TABLE "OrganizationMembership" ADD COLUMN     "team" "TeamFunction" NOT NULL DEFAULT 'QA';

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "team" "TeamFunction" NOT NULL DEFAULT 'DEVELOPER',
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BugComment" (
    "id" UUID NOT NULL,
    "bugId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BugComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BugEvent" (
    "id" UUID NOT NULL,
    "bugId" UUID NOT NULL,
    "actorId" UUID,
    "type" "BugEventType" NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BugEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorId" UUID,
    "type" "NotificationType" NOT NULL,
    "bugId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_createdAt_idx" ON "Invitation"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "BugComment_bugId_createdAt_idx" ON "BugComment"("bugId", "createdAt");

-- CreateIndex
CREATE INDEX "BugEvent_bugId_createdAt_idx" ON "BugEvent"("bugId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_organizationId_readAt_createdAt_idx" ON "Notification"("userId", "organizationId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Bug_assigneeId_status_idx" ON "Bug"("assigneeId", "status");

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BugComment" ADD CONSTRAINT "BugComment_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BugComment" ADD CONSTRAINT "BugComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BugEvent" ADD CONSTRAINT "BugEvent_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BugEvent" ADD CONSTRAINT "BugEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE CASCADE ON UPDATE CASCADE;

