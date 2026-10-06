import crypto from "node:crypto";
import type { ManualEvidenceSource } from "@prisma/client";
import { buildManualEvidenceKey, deleteObject, putObject } from "../artifacts/storage";
import { config } from "../config";
import { prisma } from "../db";

/**
 * Manual evidence goes through the same private store as execution artifacts. The type is decided
 * from the file's own leading bytes, never from the client's Content-Type or file name, so a renamed
 * HTML file cannot be stored as "image/png" and later served back to a browser.
 */

type Detected = { kind: "SCREENSHOT" | "VIDEO"; contentType: string; extension: string };

export function detectEvidenceType(body: Buffer): Detected | null {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "SCREENSHOT", contentType: "image/png", extension: "png" };
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return { kind: "SCREENSHOT", contentType: "image/jpeg", extension: "jpg" };
  if (body.length >= 12 && body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP") return { kind: "SCREENSHOT", contentType: "image/webp", extension: "webp" };
  if (body.length >= 4 && body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: "VIDEO", contentType: "video/webm", extension: "webm" };
  if (body.length >= 12 && body.toString("ascii", 4, 8) === "ftyp") return { kind: "VIDEO", contentType: "video/mp4", extension: "mp4" };
  return null;
}

export class EvidenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}

export const evidenceSelect = { id: true, testRunId: true, testCaseId: true, kind: true, source: true, fileName: true, contentType: true, byteSize: true, pageUrl: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } } as const;

/** A display name the tester recognises. The stored key never uses it. */
const cleanName = (value: string | undefined, fallback: string) => {
  const cleaned = (value ?? "").replace(/[^\w.\- ()]/g, "_").trim().slice(0, 120);
  return cleaned || fallback;
};

export async function storeEvidence(input: {
  organizationId: string;
  projectId: string;
  testRunId: string;
  testCaseId: string | null;
  userId: string;
  source: ManualEvidenceSource;
  body: Buffer;
  fileName?: string;
  pageUrl?: string | null;
}) {
  if (!input.body.length) throw new EvidenceError("EVIDENCE_EMPTY", "The file is empty.");
  const detected = detectEvidenceType(input.body);
  if (!detected) throw new EvidenceError("EVIDENCE_TYPE_UNSUPPORTED", "Only PNG, JPEG, or WebP screenshots and WebM or MP4 videos can be attached.", 415);
  const limit = detected.kind === "VIDEO" ? config.MANUAL_EVIDENCE_MAX_VIDEO_BYTES : config.MANUAL_EVIDENCE_MAX_IMAGE_BYTES;
  if (input.body.length > limit) throw new EvidenceError("EVIDENCE_TOO_LARGE", `The file is larger than the ${Math.round(limit / 1_000_000)} MB limit for ${detected.kind === "VIDEO" ? "videos" : "screenshots"}.`, 413);

  const id = crypto.randomUUID();
  const storageKey = buildManualEvidenceKey({ organizationId: input.organizationId, projectId: input.projectId, testRunId: input.testRunId, testCaseId: input.testCaseId, fileName: `${id}.${detected.extension}` });
  const stored = await putObject(storageKey, input.body);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  try {
    const [evidence] = await prisma.$transaction([
      prisma.manualEvidence.create({
        data: {
          id,
          testRunId: input.testRunId,
          projectId: input.projectId,
          testCaseId: input.testCaseId,
          kind: detected.kind,
          source: input.source,
          storageKey,
          fileName: cleanName(input.fileName, `${input.source === "UPLOAD" ? "upload" : "capture"}-${stamp}.${detected.extension}`),
          contentType: detected.contentType,
          byteSize: stored.byteSize,
          checksumSha256: stored.checksumSha256,
          pageUrl: input.pageUrl ?? null,
          uploadedById: input.userId,
        },
        select: evidenceSelect,
      }),
      prisma.manualTestEvent.create({ data: { testRunId: input.testRunId, testCaseId: input.testCaseId, userId: input.userId, type: "EVIDENCE_ADDED", detail: { evidenceId: id, source: input.source, kind: detected.kind } } }),
    ]);
    return evidence;
  } catch (error) {
    // Bytes without a row are unreachable and would only leak disk; remove them.
    await deleteObject(storageKey).catch(() => undefined);
    throw error;
  }
}
