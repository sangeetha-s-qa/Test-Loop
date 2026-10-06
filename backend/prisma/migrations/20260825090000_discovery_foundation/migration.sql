CREATE TYPE "DiscoveryStatus" AS ENUM ('QUEUED', 'DISCOVERING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "DiscoveryRun" (
  "id" UUID NOT NULL,
  "testRunId" UUID NOT NULL,
  "status" "DiscoveryStatus" NOT NULL DEFAULT 'QUEUED',
  "jobId" TEXT NOT NULL,
  "browser" TEXT NOT NULL,
  "configuration" JSONB NOT NULL,
  "pagesDiscovered" INTEGER NOT NULL DEFAULT 0,
  "linksDiscovered" INTEGER NOT NULL DEFAULT 0,
  "formsDiscovered" INTEGER NOT NULL DEFAULT 0,
  "elementsDiscovered" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "cancelRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DiscoveryRun_testRunId_key" ON "DiscoveryRun"("testRunId");
CREATE UNIQUE INDEX "DiscoveryRun_jobId_key" ON "DiscoveryRun"("jobId");
CREATE INDEX "DiscoveryRun_status_createdAt_idx" ON "DiscoveryRun"("status", "createdAt");
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DiscoveredPage" ("id" UUID NOT NULL, "discoveryRunId" UUID NOT NULL, "url" TEXT NOT NULL, "normalizedUrl" TEXT NOT NULL, "title" TEXT NOT NULL DEFAULT '', "httpStatus" INTEGER, "depth" INTEGER NOT NULL, "parentUrl" TEXT, "contentType" TEXT, "loadDurationMs" INTEGER NOT NULL, "viewport" JSONB NOT NULL, "browser" TEXT NOT NULL, "textSummary" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DiscoveredPage_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "DiscoveredPage_discoveryRunId_normalizedUrl_key" ON "DiscoveredPage"("discoveryRunId", "normalizedUrl");
CREATE INDEX "DiscoveredPage_normalizedUrl_idx" ON "DiscoveredPage"("normalizedUrl");
CREATE INDEX "DiscoveredPage_discoveryRunId_parentUrl_idx" ON "DiscoveredPage"("discoveryRunId", "parentUrl");
ALTER TABLE "DiscoveredPage" ADD CONSTRAINT "DiscoveredPage_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DiscoveredLink" ("id" UUID NOT NULL, "discoveryRunId" UUID NOT NULL, "pageId" UUID NOT NULL, "href" TEXT NOT NULL, "normalizedUrl" TEXT, "visibleText" TEXT NOT NULL DEFAULT '', "sameOrigin" BOOLEAN NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DiscoveredLink_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "DiscoveredLink_pageId_href_key" ON "DiscoveredLink"("pageId", "href");
CREATE INDEX "DiscoveredLink_discoveryRunId_normalizedUrl_idx" ON "DiscoveredLink"("discoveryRunId", "normalizedUrl");
ALTER TABLE "DiscoveredLink" ADD CONSTRAINT "DiscoveredLink_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveredLink" ADD CONSTRAINT "DiscoveredLink_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "DiscoveredPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DiscoveredForm" ("id" UUID NOT NULL, "discoveryRunId" UUID NOT NULL, "pageId" UUID NOT NULL, "identifier" TEXT NOT NULL DEFAULT '', "action" TEXT NOT NULL DEFAULT '', "method" TEXT NOT NULL DEFAULT 'get', "enctype" TEXT NOT NULL DEFAULT '', "fieldCount" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DiscoveredForm_pkey" PRIMARY KEY ("id"));
CREATE INDEX "DiscoveredForm_discoveryRunId_idx" ON "DiscoveredForm"("discoveryRunId");
ALTER TABLE "DiscoveredForm" ADD CONSTRAINT "DiscoveredForm_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveredForm" ADD CONSTRAINT "DiscoveredForm_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "DiscoveredPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DiscoveredField" ("id" UUID NOT NULL, "formId" UUID NOT NULL, "name" TEXT NOT NULL DEFAULT '', "type" TEXT NOT NULL DEFAULT '', "inputMode" TEXT, "placeholder" TEXT, "label" TEXT, "required" BOOLEAN NOT NULL DEFAULT false, "autocomplete" TEXT, "selectorCandidates" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DiscoveredField_pkey" PRIMARY KEY ("id"));
CREATE INDEX "DiscoveredField_formId_idx" ON "DiscoveredField"("formId");
ALTER TABLE "DiscoveredField" ADD CONSTRAINT "DiscoveredField_formId_fkey" FOREIGN KEY ("formId") REFERENCES "DiscoveredForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DiscoveredElement" ("id" UUID NOT NULL, "discoveryRunId" UUID NOT NULL, "pageId" UUID NOT NULL, "tagName" TEXT NOT NULL, "role" TEXT, "accessibleName" TEXT, "ariaLabel" TEXT, "ariaLabelledBy" TEXT, "ariaDescribedBy" TEXT, "selectorCandidates" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DiscoveredElement_pkey" PRIMARY KEY ("id"));
CREATE INDEX "DiscoveredElement_discoveryRunId_tagName_idx" ON "DiscoveredElement"("discoveryRunId", "tagName");
ALTER TABLE "DiscoveredElement" ADD CONSTRAINT "DiscoveredElement_discoveryRunId_fkey" FOREIGN KEY ("discoveryRunId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveredElement" ADD CONSTRAINT "DiscoveredElement_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "DiscoveredPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
