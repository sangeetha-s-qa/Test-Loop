import "dotenv/config";
import { z } from "zod";

/**
 * Treats an empty environment variable as unset. A blank `AI_PROVIDER=` in a shell or CI job
 * should disable the provider, not fail configuration validation with an enum error.
 */
const blankAsUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(value => (value === "" ? undefined : value), schema);

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(32),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  DISCOVERY_ALLOW_LOCAL_FIXTURE: z.coerce.boolean().default(false),
  DISCOVERY_MAX_PAGES: z.coerce.number().int().positive().max(500).default(50),
  DISCOVERY_MAX_DEPTH: z.coerce.number().int().min(0).max(20).default(3),
  DISCOVERY_MAX_DURATION_SECONDS: z.coerce.number().int().positive().max(1800).default(300),
  DISCOVERY_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
  DISCOVERY_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(5_000_000),
  AI_PROVIDER: blankAsUndefined(z.enum(["ollama", "openai", "anthropic", "mock"]).optional()),
  AI_MODEL: blankAsUndefined(z.string().trim().min(1).max(120).optional()),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(1_800_000).default(600_000),
  /** Budget for the first token. Covers prompt evaluation and grammar compilation, which on a
   *  CPU-only host takes minutes before any output appears. */
  AI_STREAM_FIRST_CHUNK_TIMEOUT_MS: z.coerce.number().int().positive().max(1_800_000).default(600_000),
  /** Budget between chunks once output has started. A healthy stream emits several times a second. */
  AI_STREAM_STALL_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),
  /** Upper bound on the local context window. Prompt and output share it, and a larger window costs
   *  RAM for the KV cache, so a low-memory host can lower this. Below the prompt size the provider
   *  reports truncation rather than answering on partial evidence. */
  AI_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(2048).max(131_072).default(8192),
  OPENAI_API_KEY: blankAsUndefined(z.string().min(1).optional()),
  ANTHROPIC_API_KEY: blankAsUndefined(z.string().min(1).optional()),
  AI_MAX_PAGES: z.coerce.number().int().positive().max(100).default(50),
  AI_MAX_ELEMENTS_PER_PAGE: z.coerce.number().int().positive().max(500).default(100),
  AI_MAX_TEST_CASES: z.coerce.number().int().positive().max(500).default(100),
  AUTOMATION_MAX_STEPS: z.coerce.number().int().positive().max(200).default(60),
  EXECUTION_ARTIFACT_DIR: z.string().min(1).default("./artifacts"),
  EXECUTION_MAX_DURATION_SECONDS: z.coerce.number().int().positive().max(1800).default(300),
  EXECUTION_STEP_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  EXECUTION_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
  /**
   * How long a run waits for a person before giving up.
   *
   * Keep this *below* the target application's own session timeout. A pause holds the browser
   * context open, and if the application logs us out while we wait, the resumed run fails on the
   * next step and that failure looks like a defect in the application rather than an expired wait.
   */
  MANUAL_ACTION_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(3600).default(600),
  /** How often the worker re-reads its own pause row. Polling, because the worker holds no socket. */
  MANUAL_ACTION_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(30_000).default(2000),
  /** How many times a person may push the deadline out before the run is abandoned. */
  MANUAL_ACTION_MAX_EXTENSIONS: z.coerce.number().int().min(0).max(10).default(2),
  /**
   * Ceiling on simultaneously paused runs per organization. Each one occupies a worker slot and its
   * browser's memory for as long as a human takes, so without a cap one user starves the pool.
   */
  MANUAL_ACTION_MAX_CONCURRENT: z.coerce.number().int().positive().max(64).default(3),
  /** How often a worker sweeps pauses orphaned by a worker that died mid-wait. */
  MANUAL_ACTION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(5000).max(600_000).default(60_000),
  /* Page audits (Phase 11). Deterministic per-page analysis: accessibility, performance, security. */
  AUDIT_MAX_PAGES: z.coerce.number().int().positive().max(200).default(20),
  AUDIT_PAGE_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
  AUDIT_CONCURRENCY: z.coerce.number().int().positive().max(8).default(2),
  AUDIT_ALLOW_LOCAL_FIXTURE: z.coerce.boolean().default(false),
  /**
   * Default performance budgets, in milliseconds. These are lab measurements from one cold load in
   * a headless browser, not field data - they are comparable run to run, not to what a real user on
   * a real connection sees. A run stores the thresholds it used, so a later report says what a
   * number was judged against rather than re-reading today's configuration.
   */
  AUDIT_PERF_LCP_MS: z.coerce.number().int().positive().max(60_000).default(2500),
  AUDIT_PERF_FCP_MS: z.coerce.number().int().positive().max(60_000).default(1800),
  AUDIT_PERF_TTFB_MS: z.coerce.number().int().positive().max(60_000).default(800),
  AUDIT_PERF_TBT_MS: z.coerce.number().int().positive().max(60_000).default(300),
  /**
   * Ceiling on cells in one matrix replay. Three browsers by three viewports is nine full execution
   * batches of the same suite, so the cost grows multiplicatively and a cap belongs in front of it.
   */
  /**
   * Endpoint inventory and probing limits.
   *
   * A single-page application can fire hundreds of XHRs during a crawl, so the inventory is capped
   * per discovery run rather than allowed to grow with the site.
   */
  DISCOVERY_MAX_ENDPOINTS: z.coerce.number().int().positive().max(500).default(100),
  AUDIT_MAX_ENDPOINTS: z.coerce.number().int().positive().max(200).default(40),
  AUDIT_ENDPOINT_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
  MATRIX_MAX_CELLS: z.coerce.number().int().positive().max(36).default(9),
  EXECUTION_ALLOW_LOCAL_FIXTURE: z.coerce.boolean().default(false),
  /**
   * Manual testing: whether the control plane may open a real, visible browser window for a tester.
   *
   * The window opens on the machine running the control plane, so this is only meaningful when that
   * is the tester's own machine. Unset, it is on outside production and off in production, where the
   * control plane is a server with no display and no person in front of it. Parsed as a literal
   * "true"/"false" rather than coerced, because `z.coerce.boolean()` reads the string "false" as true.
   */
  MANUAL_BROWSER_ENABLED: blankAsUndefined(z.enum(["true", "false"]).optional()),
  /** Tests only: run the "testing window" headless so a test suite does not open windows. */
  MANUAL_BROWSER_HEADLESS: blankAsUndefined(z.enum(["true", "false"]).optional()),
  /** An untouched testing window is closed after this long, so a forgotten session cannot hold a browser forever. */
  MANUAL_SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1800),
  /** Ceiling on simultaneously open testing windows per control-plane process. */
  MANUAL_SESSION_MAX_CONCURRENT: z.coerce.number().int().positive().max(16).default(3),
  /** Upload ceilings for manual evidence. Screenshots are small; a screen recording is not. */
  MANUAL_EVIDENCE_MAX_IMAGE_BYTES: z.coerce.number().int().positive().max(50_000_000).default(10_000_000),
  MANUAL_EVIDENCE_MAX_VIDEO_BYTES: z.coerce.number().int().positive().max(500_000_000).default(100_000_000),
  /** Upper bound on cases one manual generation produces. */
  MANUAL_MAX_TEST_CASES: z.coerce.number().int().positive().max(500).default(150),
  /**
   * Outgoing mail for one-time codes (sign-up verification, every sign-in, password reset).
   *
   * Any SMTP service works: Gmail and Outlook need an app password, not the account password.
   * Left unset, the auth endpoints that need email answer EMAIL_NOT_CONFIGURED instead of pretending
   * a code was sent.
   */
  /**
   * Archive switch for emailed one-time codes. "false" (the default) archives the feature: sign-up and
   * sign-in work with email and password alone, and the code and password-reset endpoints are
   * disabled. "true" restores sign-up verification, a code on every sign-in, and forgot-password -
   * all of which then need the SMTP settings below.
   */
  AUTH_EMAIL_OTP_ENABLED: z.enum(["true", "false"]).default("false"),
  SMTP_HOST: blankAsUndefined(z.string().trim().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().positive().max(65_535).default(587),
  /** "true" for implicit TLS (port 465). Port 587 negotiates STARTTLS with this left "false". */
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: blankAsUndefined(z.string().min(1).optional()),
  SMTP_PASSWORD: blankAsUndefined(z.string().min(1).optional()),
  /** Sender shown to the recipient, e.g. `Testloop <no-reply@yourdomain.com>`. Defaults to SMTP_USER. */
  SMTP_FROM: blankAsUndefined(z.string().min(3).optional()),
  /** How long an emailed code stays valid. */
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  /** Wrong guesses allowed on one code before it is locked and a new one must be requested. */
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  /** Minimum wait before another code can be requested for the same purpose. */
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(600).default(60),
  /** Ceiling on codes sent to one account per purpose per hour, so the endpoint cannot be used to flood an inbox. */
  OTP_MAX_PER_HOUR: z.coerce.number().int().min(1).max(50).default(8),
});

export const config = configSchema.parse(process.env);

/** Resolved form of MANUAL_BROWSER_ENABLED, with the environment-dependent default applied. */
export const manualBrowserEnabled = config.MANUAL_BROWSER_ENABLED ? config.MANUAL_BROWSER_ENABLED === "true" : config.NODE_ENV !== "production";
export const manualBrowserHeadless = config.MANUAL_BROWSER_HEADLESS === "true";
