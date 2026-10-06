-- AlterEnum
ALTER TYPE "AuditAnalyzer" ADD VALUE 'API';

-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "endpointsDiscovered" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DiscoveredEndpoint" (
    "id" UUID NOT NULL,
    "discoveryRunId" UUID NOT NULL,
    "pageId" UUID,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "observedStatus" INTEGER,
    "contentType" TEXT,
    "observationCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveredEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveredEndpoint_discoveryRunId_method_idx" ON "DiscoveredEndpoint"("discoveryRunId", "method");

-- CreateIndex
CREATE INDEX "DiscoveredEndpoint_pageId_idx" ON "DiscoveredEndpoint"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredEndpoint_discoveryRunId_method_normalizedUrl_key" ON "DiscoveredEndpoint"("discoveryRunId", "method", "normalizedUrl");

-- AddForeignKey
ALTER TABLE "DiscoveredEndpoint" ADD CONSTRAINT "DiscoveredEndpoint_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredEndpoint" ADD CONSTRAINT "DiscoveredEndpoint_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "DiscoveredPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
