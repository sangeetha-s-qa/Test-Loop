-- CreateEnum
CREATE TYPE "MatrixRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MatrixRun" (
    "id" UUID NOT NULL,
    "testRunId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "MatrixRunStatus" NOT NULL DEFAULT 'QUEUED',
    "baselineKey" TEXT NOT NULL,
    "cellsRequested" INTEGER NOT NULL DEFAULT 0,
    "cellsCompleted" INTEGER NOT NULL DEFAULT 0,
    "testCaseCount" INTEGER NOT NULL DEFAULT 0,
    "divergenceCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatrixRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatrixCell" (
    "id" UUID NOT NULL,
    "matrixRunId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "browser" TEXT NOT NULL,
    "viewportName" TEXT NOT NULL,
    "viewport" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatrixCell_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatrixRun_testRunId_createdAt_idx" ON "MatrixRun"("testRunId", "createdAt");

-- CreateIndex
CREATE INDEX "MatrixRun_projectId_status_idx" ON "MatrixRun"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MatrixCell_batchId_key" ON "MatrixCell"("batchId");

-- CreateIndex
CREATE INDEX "MatrixCell_matrixRunId_idx" ON "MatrixCell"("matrixRunId");

-- CreateIndex
CREATE UNIQUE INDEX "MatrixCell_matrixRunId_browser_viewportName_key" ON "MatrixCell"("matrixRunId", "browser", "viewportName");

-- AddForeignKey
ALTER TABLE "MatrixRun" ADD CONSTRAINT "MatrixRun_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatrixRun" ADD CONSTRAINT "MatrixRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatrixCell" ADD CONSTRAINT "MatrixCell_matrixRunId_fkey" FOREIGN KEY ("matrixRunId") REFERENCES "MatrixRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatrixCell" ADD CONSTRAINT "MatrixCell_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ExecutionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
