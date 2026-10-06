/**
 * Typed client for the control plane.
 *
 * Every response goes through `request`, so a failure always surfaces as an `ApiError` carrying
 * the server's error code. Nothing in the UI ever falls back to placeholder data on failure: an
 * error is shown as an error.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isUnauthenticated() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }
}

type Envelope<T> = { data: T; error?: { code: string; message: string; details?: unknown } };

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "The control plane is unreachable. Check that the API is running.");
  }

  if (response.status === 204) return undefined as T;

  let payload: Envelope<T> | null = null;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.code ?? "REQUEST_FAILED", payload?.error?.message ?? `Request failed with status ${response.status}`, payload?.error?.details ?? (payload as { data?: unknown } | null)?.data);
  }
  return payload?.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/* ------------------------------------------------------------------------------------------- */
/* Shared shapes                                                                                */
/* ------------------------------------------------------------------------------------------- */

export type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export type Me = { user: { id: string; email: string; name: string } | null; organizationId: string; role: Role; team?: "QA" | "DEVELOPER" | "PRODUCT" | "DESIGN" | "OTHER" };

export type Project = { id: string; name: string; description: string; applicationUrl: string; status: string; createdAt: string; updatedAt: string };

export type TestRun = {
  id: string;
  projectId: string;
  applicationUrl: string;
  requirements: string;
  testingTypes: string[];
  configuration: Record<string, unknown>;
  status: string;
  testingMethod?: "AUTOMATED" | "MANUAL";
  applicationType?: string | null;
  createdAt: string;
  project?: { id: string; name: string };
  discovery?: Discovery | null;
};

export type Discovery = { id: string; status: string; browser: string; pagesDiscovered: number; linksDiscovered: number; formsDiscovered: number; elementsDiscovered: number; startedAt?: string | null; completedAt?: string | null; failureCode?: string | null; failureMessage?: string | null };

export type TestCase = { id: string; testRunId: string; testCaseId: string; title: string; description: string; module: string; category: string; priority: string; severity: string; preconditions: string; steps: { step: number; action: string; expectedResult: string }[]; expectedResult: string; postconditions: string; status: "DRAFT" | "APPROVED" | "REJECTED"; currentVersion: number; modifiedByUser: boolean };

export type ValidationIssue = { severity: "ERROR" | "WARNING"; code: string; message: string; stepIndex: number | null };

export type AutomationVersion = {
  id: string;
  scriptId: string;
  version: number;
  status: "DRAFT" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  source: "AI" | "USER_EDIT" | "HEALING";
  validationStatus: "PASSED" | "PASSED_WITH_WARNINGS" | "FAILED";
  validationIssues: ValidationIssue[];
  stepCount: number;
  assertionCount: number;
  sourceCode: string;
  program: { name: string; steps: { action: string; description: string; locator?: Record<string, unknown> }[] };
  provider?: string | null;
  model?: string | null;
  createdAt: string;
  approvedAt?: string | null;
};

export type AutomationScript = {
  id: string;
  testCaseId: string;
  latestVersion: number;
  approvedVersionId: string | null;
  testCase: { id: string; testCaseId: string; title: string; module: string; priority: string; status: string };
  approvedVersion: { id: string; version: number; validationStatus: string; stepCount: number; assertionCount: number } | null;
  versions: AutomationVersion[];
};

export type AutomationGenerationRun = { id: string; status: string; provider: string; model: string; requestedCount: number; generatedCount: number; failedCount: number; error?: string | null; startedAt?: string | null; completedAt?: string | null };

export type ExecutionStatus = "QUEUED" | "PROVISIONING" | "RUNNING" | "COLLECTING_ARTIFACTS" | "PASSED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "ERRORED";

export type ExecutionBatch = {
  id: string;
  testRunId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  browser: string;
  viewport: { width: number; height: number };
  requestedCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  erroredCount: number;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type ExecutionSummary = {
  id: string;
  status: ExecutionStatus;
  browser: string;
  durationMs: number | null;
  totalSteps: number;
  passedSteps: number;
  failedStepIndex: number | null;
  failureCategory: string | null;
  failureMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  consoleErrorCount: number;
  networkFailureCount: number;
  testCase: { id: string; testCaseId: string; title: string; module: string; priority: string; severity: string };
  _count: { artifacts: number };
};

export type BatchDetail = ExecutionBatch & { testRun: { id: string; applicationUrl: string; project: { id: string; name: string } }; executions: ExecutionSummary[] };

export type StepResult = { id: string; stepIndex: number; action: string; description: string; locator: Record<string, unknown> | null; status: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "SKIPPED"; durationMs: number | null; failureCategory: string | null; failureMessage: string | null; pageUrl: string | null };

export type Artifact = { id: string; type: string; fileName: string; contentType: string; byteSize: number; checksumSha256: string; stepResultId: string | null; createdAt: string };

export type ExecutionDetail = {
  id: string;
  status: ExecutionStatus;
  browser: string;
  browserVersion: string | null;
  viewport: { width: number; height: number };
  applicationUrl: string;
  durationMs: number | null;
  totalSteps: number;
  passedSteps: number;
  failedStepIndex: number | null;
  failureCategory: string | null;
  failureMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  consoleErrorCount: number;
  networkFailureCount: number;
  testCase: { id: string; testCaseId: string; title: string; module: string; description: string; expectedResult: string };
  automationVersion: { id: string; version: number; sourceCode: string; program: unknown };
  steps: StepResult[];
  artifacts: Artifact[];
  batch: { id: string; testRunId: string };
};

export type FailureAnalysis = { id: string; version: number; status: string; provider: string; model: string; category: string | null; summary: string | null; likelyCause: string | null; recommendedAction: string | null; confidence: number | null; error: string | null; createdAt: string; completedAt: string | null };

export type HealingProposal = {
  id: string;
  stepIndex: number;
  status: "PROPOSED" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  failedLocator: Record<string, unknown>;
  proposedLocator: Record<string, unknown>;
  candidates: { accepted: { strategy: string; value: string; confidence: number; rationale: string }[]; rejected: { reason: string }[] };
  confidence: number;
  rationale: string;
  provider: string | null;
  model: string | null;
  createdAt: string;
  automationVersion?: { id: string; version: number };
  stepExecution?: { id: string; stepIndex: number; action: string; description: string; failureMessage: string | null; pageUrl: string | null } | null;
};

export type Bug = { id: string; reference: string; title: string; description: string; severity: string; status: string; occurrenceCount: number; lastSeenAt: string; createdAt: string; expectedBehavior: string; actualBehavior: string; stepsToReproduce: { step: number; action: string; description: string; status: string }[]; testCase?: { id: string; testCaseId: string; title: string } | null };

export type VisualComparison = { id: string; status: string; threshold: number; diffPixelCount: number | null; totalPixelCount: number | null; diffRatio: number | null; dimensionsMatch: boolean; baselineArtifactId: string | null; currentArtifactId: string; diffArtifactId: string | null; createdAt: string; baseline?: { id: string; name: string; browser: string; viewportWidth: number; viewportHeight: number; environment: string } };

/**
 * A run suspended on a `pauseForUser` step.
 *
 * There is no field for what the person typed, and that is deliberate rather than an omission:
 * they act in their own browser, so nothing they enter reaches the platform. Resolving is an empty
 * POST for the same reason.
 */
export type ManualAction = {
  id: string;
  executionId: string;
  testRunId: string;
  stepIndex: number;
  reason: "OTP" | "CAPTCHA" | "EMAIL_VERIFICATION" | "EXTERNAL_AUTH" | "PAYMENT_CONFIRMATION" | "FILE_UPLOAD" | "USER_APPROVAL" | "OTHER";
  prompt: string;
  status: "PENDING" | "RESOLVED" | "EXPIRED" | "ABORTED";
  pageUrl: string | null;
  deadlineAt: string;
  extensionCount: number;
  resolvedAt: string | null;
  createdAt: string;
  execution: { id: string; browser: string; testCase: { id: string; testCaseId: string; title: string } };
};

/** Human-readable titles for each pause reason, so the UI never shows a raw enum. */
export const manualActionTitles: Record<ManualAction["reason"], string> = {
  OTP: "One-time code required",
  CAPTCHA: "CAPTCHA challenge",
  EMAIL_VERIFICATION: "Email verification required",
  EXTERNAL_AUTH: "Sign-in with another service",
  PAYMENT_CONFIRMATION: "Payment confirmation required",
  FILE_UPLOAD: "A file needs to be chosen",
  USER_APPROVAL: "Your approval is needed",
  OTHER: "Manual step required",
};

/* --------------------------------------------------------------------------- page audits */

export type AuditAnalyzer = "ACCESSIBILITY" | "PERFORMANCE" | "SECURITY" | "API";
export type AuditImpact = "CRITICAL" | "SERIOUS" | "MODERATE" | "MINOR" | "INFO";

export type AuditFinding = {
  id: string;
  ruleId: string;
  impact: AuditImpact;
  title: string;
  detail: string;
  selector: string | null;
  snippet: string | null;
  helpUrl: string | null;
};

/** A measured value. `threshold` is the budget it was judged against when the run happened. */
export type PerformanceSample = { id: string; metric: string; value: number; unit: string; threshold: number | null; passed: boolean | null };

export type PageAudit = {
  id: string;
  url: string;
  analyzer: AuditAnalyzer;
  status: "PASSED" | "PASSED_WITH_WARNINGS" | "FAILED" | "ERRORED";
  durationMs: number | null;
  error: string | null;
  findings: AuditFinding[];
  samples: PerformanceSample[];
  _count: { findings: number };
};

export type AuditRun = {
  id: string;
  testRunId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  configuration: { analyzers: AuditAnalyzer[]; thresholds: Record<string, number>; allowedOrigins: string[] };
  browser: string;
  pagesRequested: number;
  pagesCompleted: number;
  findingCount: number;
  failedCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type AuditDetail = AuditRun & { pageAudits: PageAudit[] };

export const analyzerLabels: Record<AuditAnalyzer, string> = {
  ACCESSIBILITY: "Accessibility",
  PERFORMANCE: "Performance",
  SECURITY: "Security",
  API: "API",
};

/** Human names for the metrics the performance analyzer records. */
export const metricLabels: Record<string, string> = {
  largest_contentful_paint: "Largest contentful paint",
  first_contentful_paint: "First contentful paint",
  time_to_first_byte: "Time to first byte",
  total_blocking_time: "Total blocking time",
  dom_content_loaded: "DOM content loaded",
  load_event: "Load event",
  request_count: "Requests",
  transfer_bytes: "Transferred",
  response_time_ms: "Response time",
  response_bytes: "Response size",
};

/** Formats a sample in its own unit; bytes and counts are not milliseconds. */
export function formatSample(sample: PerformanceSample) {
  if (sample.unit === "bytes") return sample.value >= 1_000_000 ? `${(sample.value / 1_048_576).toFixed(1)} MB` : `${Math.round(sample.value / 1024)} KB`;
  if (sample.unit === "count") return sample.value.toLocaleString();
  return `${Math.round(sample.value).toLocaleString()} ms`;
}

/* --------------------------------------------------------------------------- matrix replay */

export type MatrixCellOutcome = { browser: string; viewportName: string; status: string; failureCategory: string | null; failureMessage: string | null };

/**
 * How a test case's result varies across the grid. `BROWSER` and `VIEWPORT` mean the result tracks
 * that axis cleanly; `INCONCLUSIVE` means some cell never reached a verdict, so it is not evidence.
 */
export type DivergenceKind = "BROWSER" | "VIEWPORT" | "MIXED" | "INCONCLUSIVE";

export type MatrixDivergence = {
  testCaseId: string;
  reference: string;
  title: string;
  kind: DivergenceKind;
  baselineStatus: string | null;
  summary: string;
  outcomes: MatrixCellOutcome[];
};

export type MatrixCell = {
  id: string;
  browser: string;
  viewportName: string;
  batchId: string;
  batch: { id: string; status: string; passedCount: number; failedCount: number; erroredCount: number; skippedCount: number; requestedCount: number; durationMs: number | null };
};

export type MatrixRun = {
  id: string;
  testRunId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  baselineKey: string;
  cellsRequested: number;
  cellsCompleted: number;
  testCaseCount: number;
  divergenceCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type MatrixDetail = MatrixRun & { cells: MatrixCell[]; divergences: MatrixDivergence[]; consistentCount: number; testCasesCompared: number };

export const divergenceLabels: Record<DivergenceKind, string> = {
  BROWSER: "Browser difference",
  VIEWPORT: "Layout difference",
  MIXED: "Specific combination",
  INCONCLUSIVE: "Not conclusive",
};

/* --------------------------------------------------------------------------- annotations */

export type AnnotationColour = "ROSE" | "AMBER" | "VIOLET" | "EMERALD";

/**
 * A region drawn over a screenshot. Coordinates are fractions of the image's own width and height,
 * so a box stays correct at any rendered size — and the image itself is never modified, so the
 * original keeps the checksum it was stored with.
 */
export type Annotation = {
  id: string;
  artifactId: string;
  bugId: string | null;
  shape: "RECTANGLE" | "ARROW" | "HIGHLIGHT";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  colour: AnnotationColour;
  createdAt: string;
};

/** Stroke and fill per colour token. The stored value is an enum, never raw CSS. */
export const annotationColours: Record<AnnotationColour, { stroke: string; fill: string; chip: string }> = {
  ROSE: { stroke: "#e11d48", fill: "rgba(225,29,72,.12)", chip: "bg-rose-600" },
  AMBER: { stroke: "#b45309", fill: "rgba(180,83,9,.12)", chip: "bg-amber-600" },
  VIOLET: { stroke: "#6d28d9", fill: "rgba(109,40,217,.12)", chip: "bg-violet-700" },
  EMERALD: { stroke: "#047857", fill: "rgba(4,120,87,.12)", chip: "bg-emerald-700" },
};

export type AiStatus = { provider: string | null; model: string | null; ready: boolean; code?: string; detail?: string };

export type ProjectReport = {
  project: { id: string; name: string };
  generatedAt: string;
  totals: { testRuns: number; testCases: number; approvedTestCases: number; automationApproved: number; executions: number; passed: number; failed: number; errored: number; cancelled: number; bugsOpen: number };
  passRate: number | null;
  averageDurationMs: number | null;
  recentBatches: ExecutionBatch[];
  topFailures: { testCaseId: string; title: string; failures: number; lastFailureAt: string }[];
};

/* ------------------------------------------------------------------------------------------- */
/* Manual testing                                                                               */
/* ------------------------------------------------------------------------------------------- */

export type TestingMethod = "AUTOMATED" | "MANUAL";
export type ManualStatus = "NOT_RUN" | "IN_PROGRESS" | "PASSED" | "FAILED" | "BLOCKED";
export type BlockedReason = "ENVIRONMENT_UNAVAILABLE" | "CREDENTIAL_UNAVAILABLE" | "APPLICATION_UNAVAILABLE" | "TEST_DATA_UNAVAILABLE" | "BROWSER_ISSUE" | "EXTERNAL_DEPENDENCY_UNAVAILABLE" | "OTHER";

/** Mirrors `manual/catalog.ts` in the API, which rejects anything outside these lists. */
export const applicationTypeOptions: { value: string; label: string }[] = [
  { value: "ECOMMERCE", label: "E-Commerce" },
  { value: "BANKING_FINTECH", label: "Banking / FinTech" },
  { value: "HEALTHCARE", label: "Healthcare" },
  { value: "EDUCATION", label: "Education / E-Learning" },
  { value: "SOCIAL_MEDIA", label: "Social Media" },
  { value: "SAAS", label: "SaaS / Web Application" },
  { value: "BOOKING", label: "Booking / Reservation" },
  { value: "LOGISTICS", label: "Logistics / Delivery" },
  { value: "REAL_ESTATE", label: "Real Estate" },
  { value: "ERP", label: "ERP / Enterprise" },
  { value: "CONTENT_MEDIA", label: "Content / Media" },
  { value: "GAMING", label: "Gaming" },
  { value: "ADMIN_PORTAL", label: "Admin / Management Portal" },
  { value: "BUSINESS_CORPORATE", label: "Business / Corporate" },
  { value: "OTHER", label: "Other" },
];

export const manualTestingTypeOptions = ["Functional", "UI/UX", "End-to-End", "Flow", "Smoke", "Sanity", "Regression", "Integration", "CRUD", "Accessibility", "Responsive", "Cross-browser", "Mobile", "Web", "API", "Security", "Performance", "Other"] as const;

export const blockedReasonLabels: Record<BlockedReason, string> = {
  ENVIRONMENT_UNAVAILABLE: "Environment unavailable",
  CREDENTIAL_UNAVAILABLE: "Required credential unavailable",
  APPLICATION_UNAVAILABLE: "Application unavailable",
  TEST_DATA_UNAVAILABLE: "Test data unavailable",
  BROWSER_ISSUE: "Browser issue",
  EXTERNAL_DEPENDENCY_UNAVAILABLE: "External dependency unavailable",
  OTHER: "Other",
};

export const manualStatusLabels: Record<ManualStatus, string> = { NOT_RUN: "Not run", IN_PROGRESS: "In progress", PASSED: "Passed", FAILED: "Failed", BLOCKED: "Blocked" };

export type ManualProgress = { total: number; passed: number; failed: number; blocked: number; notRun: number; inProgress: number; executed: number; percentComplete: number; passRate: number | null };

export type ManualSession = { id: string; status: "STARTING" | "ACTIVE" | "CLOSED" | "CRASHED" | "FAILED"; browser: string; targetUrl: string; startedAt: string; lastActivityAt: string; endedAt: string | null; endReason: string | null; lastError: string | null; currentUrl: string | null };

export type ManualRun = TestRun & {
  testingMethod: TestingMethod;
  applicationType: string | null;
  startedAt: string | null;
  completedAt: string | null;
  phase: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  progress: ManualProgress;
  settings: { autoScreenshotOnFail: boolean };
  discovery: { id: string; status: string; pagesDiscovered: number; formsDiscovered: number; linksDiscovered: number; failureMessage: string | null } | null;
  referenceCount: number;
  session: ManualSession | null;
  browserCapability: { enabled: boolean; reason: string | null };
};

export type ManualCase = {
  id: string;
  testRunId: string;
  testCaseId: string;
  title: string;
  description: string;
  module: string;
  category: string;
  priority: string;
  severity: string;
  preconditions: string;
  testData: Record<string, string>;
  steps: { step: number; action: string; expectedResult: string }[];
  expectedResult: string;
  postconditions: string;
  generationSource: string;
  manualStatus: ManualStatus;
  actualResult: string;
  testerNotes: string;
  blockedReason: BlockedReason | null;
  executedAt: string | null;
  updatedAt: string;
  executedBy: { id: string; name: string } | null;
  _count: { manualEvidence: number };
  /** The bug raised from this case, when there is one. */
  bugs?: { id: string; reference: string; status: string; assignee: { name: string } | null }[];
};

export type ManualEvidence = { id: string; testRunId: string; testCaseId: string | null; kind: "SCREENSHOT" | "VIDEO"; source: "BROWSER_CAPTURE" | "AUTO_ON_FAIL" | "UPLOAD"; fileName: string; contentType: string; byteSize: number; pageUrl: string | null; createdAt: string; uploadedBy: { id: string; name: string } | null };

export type ManualResultResponse = { testCase: ManualCase; progress: ManualProgress; runStatus: string; autoCapture: { attempted: boolean; captured: boolean; reason: string | null } };

/** Sends a file as the raw request body. The API decides the type from the bytes, not from this header. */
export async function uploadEvidence<T>(path: string, file: Blob, fileName: string): Promise<T> {
  return request<T>(path, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(fileName) } });
}

export async function manualEvidenceUrl(evidenceId: string) {
  const data = await api.get<{ id: string; fileName: string; contentType: string; byteSize: number; url: string }>(`/api/v1/manual-evidence/${evidenceId}/url`);
  return { ...data, url: `${API_URL}${data.url}` };
}

/** Mints a short-lived signed URL, then returns the absolute address the browser can fetch. */
export async function artifactUrl(artifactId: string) {
  const data = await api.get<{ id: string; fileName: string; contentType: string; byteSize: number; url: string }>(`/api/v1/artifacts/${artifactId}/url`);
  return { ...data, url: `${API_URL}${data.url}` };
}

export const formatDuration = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/* ------------------------------------------------------------------------------------------- */
/* Organization-wide catalogue views                                                            */
/* ------------------------------------------------------------------------------------------- */

type RunRef = { id: string; applicationUrl: string; project: { id: string; name: string } };
type CaseRef = { id: string; testCaseId: string; title: string };

export type CatalogTestCase = {
  id: string; testCaseId: string; title: string; module: string; category: string; priority: string;
  severity: string; status: "DRAFT" | "APPROVED" | "REJECTED"; generationSource: string;
  modifiedByUser: boolean; createdAt: string; testRun: RunRef;
};

export type GenerationRun = {
  id: string; status: string; provider: string | null; model: string | null; promptVersion: string | null;
  scenarioCount: number; testCaseCount: number; error: string | null;
  startedAt: string | null; completedAt: string | null; createdAt: string; testRun: RunRef;
};

export type AnalysisRecord = {
  id: string; status: string; provider: string | null; model: string | null; category: string | null;
  summary: string | null; likelyCause: string | null; recommendedAction: string | null;
  confidence: number | null; error: string | null; createdAt: string; completedAt: string | null;
  execution: { id: string; status: string; failureCategory: string | null; failureMessage: string | null; testCase: CaseRef };
};

export type HealingRecord = {
  id: string; status: "PROPOSED" | "APPROVED" | "REJECTED" | "SUPERSEDED"; stepIndex: number;
  failedLocator: Record<string, unknown>; proposedLocator: Record<string, unknown>; confidence: number;
  rationale: string; provider: string | null; model: string | null; createdAt: string;
  automationVersion: { id: string; version: number } | null;
  script: { id: string; testCase: CaseRef };
};

export type VisualRecord = {
  id: string; status: string; threshold: number; diffPixelCount: number | null; totalPixelCount: number | null;
  diffRatio: number | null; dimensionsMatch: boolean; baselineArtifactId: string | null;
  currentArtifactId: string; diffArtifactId: string | null; createdAt: string;
  baseline: { id: string; name: string; browser: string; viewportWidth: number; viewportHeight: number; environment: string } | null;
  execution: { id: string; testCase: CaseRef };
};

export type CatalogBug = {
  id: string; reference: string; title: string; severity: string; status: string; occurrenceCount: number;
  lastSeenAt: string; createdAt: string; project: { id: string; name: string }; testCase: CaseRef | null;
};

/** Daily execution counts and per-type totals, both derived from real rows. */
export type DashboardTrend = {
  comparedTo: string; hasBaseline: boolean;
  total: number | null; passed: number | null; failed: number | null; errored: number | null;
};
export type DashboardPoint = { date: string; passed: number; failed: number; errored: number };
export type DashboardTypeTally = { type: string; passed: number; failed: number; total: number };

/** Formats a ratio as a signed percentage, or null when there is no baseline to compare against. */
export const formatTrend = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? null : `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;

export const formatDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const formatRelative = (value: string | null | undefined) => {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
};

/* Discovery detail --------------------------------------------------------------------------- */

export type DiscoveredPage = { id: string; normalizedUrl: string; title: string; depth: number; parentUrl: string | null; statusCode?: number | null };
export type DiscoveredForm = { id: string; pageId: string; identifier: string; action: string; method: string; fields: { id: string; name: string; type: string; label: string | null; required: boolean; placeholder: string | null }[] };
export type DiscoveredElement = { id: string; pageId: string; tagName: string; role: string | null; accessibleName: string | null; selectorCandidates: unknown };
export type DiscoveryMap = {
  discoveryRunId: string;
  status: string;
  root: string | null;
  pages: (DiscoveredPage & { children: string[]; outgoingLinks: { pageId: string; normalizedUrl: string | null; visibleText: string; sameOrigin: boolean }[] })[];
};
