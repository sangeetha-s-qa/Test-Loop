-- CreateEnum
CREATE TYPE "AnnotationShape" AS ENUM ('RECTANGLE', 'ARROW', 'HIGHLIGHT');

-- CreateEnum
CREATE TYPE "AnnotationColour" AS ENUM ('ROSE', 'AMBER', 'VIOLET', 'EMERALD');

-- CreateTable
CREATE TABLE "Annotation" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "bugId" UUID,
    "shape" "AnnotationShape" NOT NULL DEFAULT 'RECTANGLE',
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL,
    "colour" "AnnotationColour" NOT NULL DEFAULT 'ROSE',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Annotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Annotation_artifactId_createdAt_idx" ON "Annotation"("artifactId", "createdAt");

-- CreateIndex
CREATE INDEX "Annotation_bugId_idx" ON "Annotation"("bugId");

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ExecutionArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_bugId_fkey" FOREIGN KEY ("bugId") REFERENCES "Bug"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
