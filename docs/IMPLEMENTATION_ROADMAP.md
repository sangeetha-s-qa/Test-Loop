# Testloop Implementation Roadmap

## Status

Phases 0-8 are implemented and verified against live infrastructure. Phase 9 is partially complete.

A checked box means the item is implemented AND covered by a test that actually exercises it.

## Delivery Principles

1. Build a modular monolith for the control plane.
2. Run all crawling, browser automation, visual comparison, and other untrusted work in isolated worker processes or containers.
3. PostgreSQL is the durable system of record; Redis is not authoritative.
4. Use TypeScript strict mode, shared API contracts, schema migrations, and validated configuration.
5. Treat AI output and website content as untrusted, versioned data requiring schema validation.
6. Make long-running jobs idempotent, observable, cancellable, retryable, and recoverable.
7. Never silently overwrite approved test, automation, AI, or visual-baseline versions.
8. Never expose secrets, stack traces, internal network details, or unsigned artifact paths to clients.

## Phase 0: Repository Foundation and Architecture Gates - COMPLETE

- [x] Initialize monorepo with frontend, control plane, workers, and shared packages.
- [x] Configure TypeScript strict mode, formatting, linting, and tests.
- [x] Define shared Zod/TypeScript contracts.
- [x] Add environment/config validation (`src/config.ts`, parsed and validated at startup).
- [x] Add Docker development services for PostgreSQL and Redis.
- [x] Define structured logging and health checks.
- [x] Define database migration policy.
- [x] Pin Playwright/browser versions.
- [ ] OpenAPI document, request-ID propagation, metrics, and tracing hooks. *(deferred to Phase 9)*

## Phase 1: Tenancy, Authentication, and Authorization - COMPLETE

- [x] User, Organization, OrganizationMembership, Project, ProjectMembership models.
- [x] Signup, login, logout, signed session cookies.
- [x] Password hashing, HttpOnly/SameSite cookies, auth rate limits, generic auth errors.
- [x] OWNER, ADMIN, MEMBER, VIEWER roles; `canWrite` / `canApprove` policy helpers in `src/http.ts`.
- [x] Organization/project authorization enforced on every query, mutation, job, and artifact request.
- [ ] Email verification, password recovery, refresh-token rotation, API keys, audit events. *(deferred)*

Gate: cross-tenant access verified for direct-ID access and artifact URL access in
`src/testing/authorization.integration.test.ts`.

## Phase 2: Projects, Requirements, and Durable Job Infrastructure - COMPLETE

- [x] Project CRUD with tenant indexes.
- [x] Durable job state in PostgreSQL (`DiscoveryRun`, `AIGenerationRun`, `AutomationGenerationRun`,
      `ExecutionBatch`, `TestExecution`, `FailureAnalysis`), each with its own status machine.
- [x] Separate BullMQ queues: `discovery`, `ai-generation`, `generate-automation`, `execute-tests`,
      `analyze-failures`.
- [x] Bounded retries with exponential backoff, timeouts, and durable cancellation.
- [x] Deterministic job ids so duplicate dispatch is collapsed.
- [x] Workers re-verify tenancy before processing, so a tampered or replayed payload is refused.
- [ ] Dead-letter replay, per-tenant quota/priority, worker heartbeats, operational alerts. *(deferred to Phase 9)*

## Phase 3: Secure Crawler and Application Discovery - COMPLETE

- [x] Isolated crawler worker.
- [x] HTTP/HTTPS validation, DNS/IP SSRF checks, redirect re-checks, port policy, metadata blocking.
- [x] IPv6 literals correctly blocked (see defect 1 below).
- [x] Same-origin policy with depth/page/size/runtime limits.
- [x] Normalized pages, links, forms, fields, and interactive elements captured.
- [x] Progress counters and cancellation.
- [x] Page content treated as untrusted data with prompt-injection boundaries before AI use.

Gate: `src/discovery/scope.test.ts` blocks private, loopback, link-local, IPv6, and metadata
targets; `src/fixture/server.test.ts` crawls a real fixture in all three browsers.

## Phase 4: AI Discovery and Test Case Generation - COMPLETE

- [x] Provider interface with **Ollama (local)**, OpenAI, Anthropic, and mock adapters.
- [x] Versioned prompts (`promptVersion`), JSON schemas (`schemaVersion`), and bounded repair policy
      (`src/ai/structured.ts`).
- [x] Records latency, token usage, provider request id, attempt count, and validation status.
- [x] Prompt-injection boundaries, bounded prompt size, bounded output size.
- [x] Generates scenarios and cases from completed discovery data.
- [x] Validates, deduplicates, and drops provenance ids the crawler never produced.
- [x] Review, approval, editing, regeneration, and **immutable `TestCaseVersion` records**.
- [x] `checkProviderReady()` reports an unusable provider honestly instead of queueing doomed work.

Gate: `src/ai/structured.test.ts` proves invalid or truncated output cannot reach persistence.

## Phase 5: Automation Generation and Validation - COMPLETE

Generated automation is a **validated declarative step program**, not a code string. The Phase 5
gate requires that generated automation cannot reach host resources or forbidden network targets;
a closed set of typed actions makes that true by construction, because the runner has no `eval`,
no filesystem action, and no arbitrary-URL action. A readable Playwright spec is rendered from the
program for review and export and is never executed.

- [x] Generate automation from approved `TestCaseVersion` records.
- [x] Store `AutomationScript` and immutable `AutomationVersion` metadata.
- [x] Parse and policy-validate generated programs before storage and again before execution.
- [x] Locator strategy validation, secret-shaped-value rejection, off-origin navigation rejection.
- [x] A program that fails policy validation is rejected with 422, not stored.
- [x] Reviewable editing: an edit stores a new draft version and never mutates the one being revised.
- [x] Manual authoring path so the platform is usable with no AI provider at all.
- [x] Healing proposal model and approval workflow.
- [x] Approval required before a version becomes executable; approving supersedes rather than deletes.

Gate covered by `src/automation/validate.test.ts`, `src/automation/renderer.test.ts`, and the
pipeline integration test.

## Phase 6: Isolated Playwright Execution and Artifacts - COMPLETE

- [x] `QUEUED -> PROVISIONING -> RUNNING -> COLLECTING_ARTIFACTS -> PASSED | FAILED | TIMED_OUT | CANCELLED | ERRORED`.
- [x] Fresh browser context per execution; no shared storage state, cookies, or credentials.
- [x] Duration ceiling, per-step timeout, and durable cancellation checked at each step boundary.
- [x] Browser and temporary directory released in a `finally` block even when the run throws.
- [x] Failure classification; **only `INFRASTRUCTURE` failures are retryable**, so a real assertion
      failure is never retried away.
- [x] Screenshots, video, trace, HAR, console log, and network log captured according to the run's
      settings; only artifacts that were actually written are recorded.
- [x] Console and network evidence redacted for credential-shaped values before storage.
- [x] Private artifact storage with server-generated keys, SHA-256 checksums, and short-lived
      HMAC-signed download tokens; authorization is checked when the token is minted.
- [x] Reconnectable SSE progress backed by persisted `ExecutionEvent` rows with a replay cursor.
- [x] SSRF re-checked before launch and enforced at the network layer during the run.
- [ ] Container-level CPU/memory/disk/pid limits. *(needs a container runtime; see README limitations)*

Gate covered by `src/execution/runner.test.ts` (11 tests driving real Chromium) and the pipeline
integration test, which covers pass, assertion failure, cancellation, artifact download, and
unauthorized artifact access.

## Phase 7: Failure Analysis, Bugs, and Visual Regression - COMPLETE

- [x] Structured AI failure analysis with evidence references, confidence, and **versioned**
      results; a re-analysis creates a new version and never rewrites the previous one.
- [x] The model's category is stored separately from the runner's recorded `FailureCategory`, so an
      AI opinion can never overwrite an observed machine fact.
- [x] Analysis refuses to run on an execution that did not fail.
- [x] Idempotent bug creation keyed on a normalised failure fingerprint; a repeat increments the
      occurrence count instead of creating a second bug.
- [x] Duplicate candidates, review, status/severity workflow, source execution linkage.
- [x] `VisualBaseline` / `VisualBaselineVersion` scoped by test case, browser, viewport, device
      scale factor, and environment.
- [x] Deterministic pixel comparison with masks, thresholds, and diff artifacts.
- [x] **Baselines are never auto-approved or overwritten**; approving creates a new immutable version.
- [x] Self-healing proposals reject candidates that match zero or multiple elements in the captured
      DOM evidence, regardless of the model's stated confidence.
- [x] Approving a healing proposal produces a **new draft** version that still needs its own
      approval; only one locator changes and assertions are copied verbatim.

Gate covered by `src/analysis/healing.test.ts`, `src/analysis/bugs.test.ts`, and
`src/visual/compare.test.ts`.

## Phase 8: Frontend Workflows - COMPLETE

- [x] Auth, permission-aware navigation, and a shell showing the real signed-in user.
- [x] Project overview, crawl progress, application map, test-case review, **automation review**,
      **execution results**, **execution detail**, bugs, reports, settings.
- [x] Screenshots, videos, traces, and logs served through signed URLs.
- [x] Typed API client with a single error envelope; filters, search, and status filters.
- [x] Loading, empty, error, permission-denied, cancellation, and disabled-prerequisite states
      (`src/components/states.tsx`).
- [x] Polling-based live progress for in-flight discovery, generation, and execution.
- [x] **All hard-coded demo data removed.** The projects page and dashboard read real records;
      a metric with no data renders an em dash, never a fabricated `0%`.
- [ ] Cursor pagination and SSE-based (rather than polled) realtime progress in the UI. *(deferred)*

## Phase 9: Production Readiness - PARTIAL

- [x] Unit, browser, security, and tenant-isolation test suites.
- [x] Integration suite covering the full pipeline, authorization, artifacts, and cancellation.
- [x] Secrets kept out of API responses, logs, and documentation; `.gitignore` covers `.env`.
- [x] Documentation: setup, environment variables, workers, commands, testing, limitations.
- [ ] Dependency, container, secret, and static security scanning.
- [ ] Backup encryption, restore procedure, retention/deletion/export flows, artifact lifecycle.
- [ ] SLOs, quotas, cost budgets, alert thresholds, incident response, runbooks.
- [ ] Autoscaling, backpressure, noisy-neighbor controls, queue recovery, database archival.
- [ ] Feature flags and gradual rollout strategy.
- [ ] Threat model and release checklist.

## Phase 10: Human-in-the-Loop Manual Actions - COMPLETE

Lets a run test an application that is gated on something the platform must not do itself - an OTP,
a CAPTCHA, a payment confirmation - by suspending instead of failing.

- [x] `pauseForUser` automation step: a closed reason set, a bounded prompt, and deliberately **no
      value field**. The person acts in their own browser, so a stored program has nowhere to hold
      what they typed and no artifact or log can leak it.
- [x] Policy rules in `validateProgram`: at most two pauses per program, a pause may not be the last
      step (nothing after it is verified), and a prompt may not ask the person to enter a code into
      the platform or send one to us.
- [x] `renderPlaywrightSpec` emits a pause as a labelled no-op `test.step`, because an exported spec
      has nobody to wait for and must read as a gap rather than a call to a helper that does not exist.
- [x] The runner **fails closed**: a pause with no broker wired raises `POLICY_VIOLATION` rather than
      skipping the step. Skipping would sail past an unverified OTP and report a pass for a flow
      nobody completed.
- [x] `ManualAction` model with `ManualActionReason` and `ManualActionStatus`; `WAITING_FOR_USER`
      added to both `TestRunStatus` and `ExecutionStatus`; `MANUAL_ACTION_EXPIRED` and
      `MANUAL_ACTION_ABORTED` added to `FailureCategory`.
- [x] Broker (`execution/manual-action.ts`): writes a durable row, holds the browser context open,
      polls the row, and enforces a deadline. The exchange goes through the database rather than
      process memory, so a wait survives a worker restart.
- [x] The paused time is added back to the execution deadline. A person cannot be held to the
      per-execution budget, and charging them for it would time the run out the moment they returned.
- [x] An unanswered pause is `ERRORED`, never `FAILED`. `FAILED` is a claim about the application
      under test, and a run nobody unblocked never got far enough to make one.
- [x] API: list per run, read one, resolve, abort, extend. Resolve takes an **empty body** - there is
      no field for a code. Settling is a single conditional update, so two people answering at once
      cannot both win and a resolve cannot overwrite an expiry the worker already recorded.
- [x] UI: `ManualActionBanner` on the run page, polling every 5s, with a dialog that states plainly
      that the code is never requested, counts down to the deadline, and offers extend / abort / confirm.
- [x] Per-organization ceiling on concurrent pauses (`MANUAL_ACTION_MAX_CONCURRENT`), checked before
      the row is created, so one user cannot starve the worker pool.
- [x] `expireOverdueManualActions()` sweeps rows whose worker died mid-pause and would otherwise
      hold concurrency budget forever.
- [x] Covered by 12 unit tests and 10 integration tests against live PostgreSQL, including the real
      suspend/resume cycle, the expiry path, tenant isolation, and concurrent settlement.

### Known gaps in this phase

- No screenshot is captured at the moment of the pause. Artifacts are stored after the context
  closes, so capturing one mid-run needs the artifact path refactored - the dialog shows the page
  URL instead.
- The banner polls every 5s. The SSE endpoint in the architecture would make this immediate.

## Phase 11: Page Audits - COMPLETE

Accessibility, performance and security as one deterministic sweep over the pages discovery reached.
This is what turns the testing-type list into something the platform actually does: the twenty-eight
types in the product spec collapse onto four evidence sources, and this phase builds the second one.

**Nothing in an audit is generated.** An axe rule id, a missing `Strict-Transport-Security` header
and a measured largest-contentful-paint are facts the reader can check. A model may later *explain*
a finding; it may never produce one. That is why this phase adds no AI dependency at all.

- [x] `AuditRun`, `PageAudit`, `AuditFinding` and `PerformanceSample` models, with `AuditAnalyzer`,
      `AuditRunStatus`, `AuditPageStatus` and `AuditImpact` enums. One `PageAudit` per analyzer per
      page, so a report shows a gap rather than silently listing fewer pages.
- [x] **Accessibility**: axe-core 4.13 injected into the live page - the rules need computed styles,
      so contrast cannot be judged from markup. Findings carry the published rule id and help URL.
      Per-rule node lists are capped at 10 with a roll-up row, because a hundred identical rows is
      noise rather than evidence.
- [x] **Performance**: navigation timing plus `PerformanceObserver` probes installed on the context
      *before* navigation - largest-contentful-paint and long tasks are only delivered to an observer
      that was already listening. Total blocking time counts only the part of a task beyond 50ms.
      A metric the engine did not report is **omitted, never recorded as zero**; a zero would read as
      a perfect score for something nobody measured.
- [x] Pass/fail is arithmetic against a stored threshold, and severity is a ratio: twice the budget
      is SERIOUS, four times is CRITICAL. The run stores the thresholds it used, so a later report
      says what a number was judged against instead of re-reading today's configuration.
- [x] **Security**: observation only - response headers, cookie attributes, mixed content, plaintext
      transport. HSTS is not demanded of a page never served over HTTPS. No injection payload, no
      authentication bypass, no fuzzing; that needs a consented engagement with a defined scope.
- [x] **Per-project egress allowlist** (`Project.egressAllowlist`). Execution is same-origin by
      default, which is right for an untrusted target but makes a performance number meaningless: an
      LCP measured with the site's CDN blocked is not what a visitor experiences. The allowlist
      waives the **same-origin rule and nothing else** - every SSRF check still runs on an
      allowlisted entry, so "allowlist a CDN" can never become "reach 169.254.169.254". Covered by a
      test that allowlists a metadata address and asserts it is still blocked.
- [x] Audit worker on its own queue and concurrency, wired into `npm run workers`.
- [x] API: start (gated on discovery having completed), list, read, cancel, and set the allowlist.
      Allowlist entries are normalised to bare origins and de-duplicated on write.
- [x] UI at `/test-runs/[id]/audits`: summary tiles, an analyzer tab bar, findings grouped by rule so
      one bad rule across twenty pages reads as one problem, and a performance table whose columns
      are only the metrics that were actually reported.
- [x] Covered by 10 unit tests against a real browser and 6 integration tests that run the whole
      sweep against a live browser and the local fixture.

### Known gaps in this phase

- The API analyzer (§11 of the product spec) is not built; the other three analyzers are.
- Audits run at one viewport. Responsive and cross-browser are the matrix-replay engine, not this one.
- No sampling strategy: the sweep audits up to `AUDIT_MAX_PAGES` in discovery order. A large site
  needs prioritisation before a full sweep is affordable.

## Phase 12: Matrix Replay - COMPLETE

Cross-browser, responsive and compatibility testing, which the product spec lists as three separate
testing types, are one engine: replay the automation a person already approved across a grid of
browsers and viewports, then compare the results.

**This engine authors nothing and generates nothing.** The programs that run in every cell are the
ones already reviewed and approved, unchanged - which is exactly what makes a difference between two
cells evidence about the *application* rather than about two different tests.

- [x] `MatrixRun` and `MatrixCell` models. A cell is backed by an ordinary `ExecutionBatch`, so
      artifacts, step results, failure analysis and healing all apply to a matrix run with no new
      code. The whole engine is orchestration plus a comparison.
- [x] All cells are created in one transaction. A partially-built matrix would compare a complete
      cell against one that was never going to run and report the difference as a browser bug.
- [x] Executions are enqueued *after* the transaction commits, so a worker cannot pick up a job
      whose row is not visible yet.
- [x] `MATRIX_MAX_CELLS` (default 9). Three browsers by three viewports is nine full runs of the
      suite, so cost grows multiplicatively and the cap belongs in front of it. Browser and viewport
      lists are de-duplicated, so "chromium, chromium" cannot silently double the bill.
- [x] **Divergence classification** (`matrix/divergence.ts`), the part that makes a matrix worth
      running. A raw list of failures cannot tell a reviewer whether they are looking at one Safari
      bug or one mobile-layout bug:
      - `BROWSER` - the result tracks the engine and is the same at every viewport within it.
      - `VIEWPORT` - the result tracks the size and is the same in every browser at that size.
      - `MIXED` - neither, which usually means one specific combination is broken.
      - `INCONCLUSIVE` - a cell errored, timed out or was cancelled, so there is nothing trustworthy
        to compare. **Only PASSED and FAILED are comparable**; treating an ERRORED cell as "this
        browser fails" would manufacture cross-browser bugs out of infrastructure noise.
- [x] A case that fails in *every* cell is not a divergence. It is an ordinary failure the run
      already reports, and repeating it here would bury the handful of rows this screen exists for.
- [x] Divergences are derived from the executions rather than stored: a terminal execution is
      immutable, so recomputing always gives the same answer and a stored copy could only ever
      disagree with its own source. Only the summary count is denormalised, for the list view.
- [x] Matrix roll-up is hooked into `refreshBatch`, because every path that settles a batch -
      success, failure, cancellation - already funnels through that one function.
- [x] Cancel stops unfinished cells and keeps the results of those that already ran; a cancelled
      matrix cannot be resurrected by a straggling cell finishing afterwards.
- [x] API: start (order is meaningful - the first browser and viewport become the baseline), list,
      read, cancel. UI at `/test-runs/[id]/matrix`: the grid with per-cell totals, and the
      difference list with the axis each one follows.
- [x] Covered by 8 unit tests pinning the classification rules against a real 3x3 grid, and 7
      integration tests covering orchestration, tenant isolation, divergence detection and cancellation.

### Known gaps in this phase

- **One matrix cannot distinguish a flake from a real difference.** An errored cell is reported as
  inconclusive, but a genuine-looking single-cell failure can still be intermittent. Confirming
  means re-running the grid; there is no automatic re-run of only the diverging cells.
- Viewports are the three presets. A custom size is not offered here.
- A matrix does not capture a visual diff between cells; comparison is by verdict, not by pixels.

## Phase 13: API Endpoint Inventory and Probing - COMPLETE

The fourth and last analyzer, closing the testing-type list from the product spec. Endpoints are
discovered by watching the application call itself, then replayed - but only the ones that are safe
to repeat.

- [x] `DiscoveredEndpoint` model and capture in the crawler. The crawler records the XHR and fetch
      traffic **the page generated on its own** and never issues a request of its own, so building
      an inventory is a transcript rather than a probe. Same-origin only; a document navigation is
      not an endpoint.
- [x] Keyed by method plus path with the query stripped, so a paginated list is one endpoint rather
      than one row per page number. A concrete observed URL is kept alongside it so a probe has
      something real to replay. Capped by `DISCOVERY_MAX_ENDPOINTS` - a single-page application can
      fire hundreds of XHRs during a crawl.
- [x] **Only idempotent methods are ever called.** A POST, PUT, PATCH or DELETE seen during a crawl
      is inventory and nothing more: replaying one could create an order, overwrite a record, or
      delete a customer. The crawler deliberately never submits a form, and it would be incoherent
      for the prober to do the same thing by another route. Non-idempotent endpoints are recorded
      with an INFO finding naming the reason, and a test asserts the server received no such call.
- [x] **Probes are anonymous** - no cookie, no token, no header copied from the observed call. What
      the analyzer reports is therefore what an unauthenticated caller can reach, which is a fact
      worth knowing and is not the same question as "does this work when signed in".
- [x] Findings: server error, malformed JSON against a declared JSON content type, missing content
      type, status drift, timeout, unreachable, blocked by egress policy, and a credential pattern
      in a response body.
- [x] A leaked-credential finding **does not copy the credential into the finding**. Recording the
      secret in order to report it would be the same disclosure, one layer down; the report names
      the kind of value and asks for a manual check.
- [x] An endpoint answering 401 to an anonymous probe is described as an observation, not diagnosed
      as a defect - it usually means the endpoint needs a session, which is correct behaviour.
- [x] Redirects are not followed (`redirect: "manual"`); following one could walk off the approved
      origin, and the redirect is itself part of what is being observed. Every probe re-runs the
      full SSRF check, and the sweep is sequential so it cannot become a load test.
- [x] Runs as a fourth `AuditAnalyzer` reusing `AuditRun`, `PageAudit` and `AuditFinding`, but as
      its own pass: it walks the endpoint inventory rather than the page list and needs no browser
      at all. Asking for API alone skips browser launch entirely.
- [x] The local fixture now serves a JSON endpoint and fetches it on load, so endpoint capture is
      verified end to end against a real crawl rather than seeded.
- [x] Covered by 9 unit tests against a real HTTP server and 4 integration tests.

### Known gaps in this phase

- No schema assertion. The prober checks that a JSON response parses, not that it matches a
  contract; there is no OpenAPI or JSON Schema input yet.
- Endpoints behind authentication are only ever seen anonymously, so an authenticated probe of the
  same endpoint is not offered.
- Path parameters are not templated: `/api/orders/1` and `/api/orders/2` are two inventory rows.

## Phase 14: Screenshot Annotation - COMPLETE

Marking what is wrong on the evidence itself, which the product spec calls a core requirement.

- [x] `Annotation` model storing a region as a **vector in normalised coordinates** (fractions of
      the image's own width and height) rather than painting pixels into the file.
- [x] **The original is never modified, by construction.** There is no code path that rewrites an
      artifact, so the stored screenshot still matches the checksum it was recorded with and stays
      verifiable. "Never destroy the evidence" is a property of the schema, not a rule someone has
      to remember. An integration test asserts the checksum and byte size are unchanged after a
      region is added and removed.
- [x] Consequences of storing vectors: a box can be moved or relabelled afterwards, one screenshot
      can carry regions for several bugs, and the overlay scales correctly at any rendered size.
- [x] Colour is a closed enum, so a stored value can never become styling the browser has to
      interpret.
- [x] Regions are bounded to the image; one extending past an edge is refused.
- [x] Only image artifacts can be annotated - a box over a trace file would mean nothing.
- [x] A region may reference a bug only in the same organization, or an annotation would become a
      way to learn that another tenant's bug id exists.
- [x] API: list, create, update, delete. Tenant-scoped through artifact to execution to project.
- [x] UI: `AnnotatedScreenshot` draws boxes over the signed-URL image with an SVG layer. Drag to
      mark, label it, pick a colour. "Show original" hides the layer rather than loading a different
      file, because there is only one file. Wired into the bug evidence view and execution screenshots.
- [x] Covered by 5 integration tests including the checksum-unchanged invariant and tenant isolation.

### Known gaps in this phase

- Only rectangles are drawn. `ARROW` and `HIGHLIGHT` exist in the schema and are not yet drawable.
- Existing regions cannot be dragged to move or resize after they are saved; they can be deleted
  and redrawn.
- **No flattened export yet.** A PDF or a shared image file needs the overlay composited onto a copy
  of the screenshot, which is part of the report-export work and is not built.

## Verification status

Every check below was actually executed against live infrastructure.

| Check | State |
| --- | --- |
| Prisma schema validates | Verified |
| Migrations applied to live PostgreSQL | Verified - "Database schema is up to date!" (6 migrations) |
| Backend typecheck / lint / build | Verified |
| Frontend typecheck / lint / build | Verified (21 routes) |
| Backend unit + browser tests | Verified - 124 passing, including real Chromium, Firefox, and WebKit execution |
| Integration tests | Verified - 41 passing against live PostgreSQL |
| Tenant isolation, IDOR, SSRF, secret leakage | Verified - 9 tests |
| Malformed resource ids answer 404, never 500, on every router | Verified - 16 tests |
| Full pipeline: crawl, approve, automate, execute, artifacts, bug, report, cancel | Verified - 15 tests |
| Ollama provider with a real local model | Verified - `qwen2.5:3b-instruct` (the 7B model does not fit this host; see README sizing table) |
| All five workers processing real BullMQ jobs | Verified |

### Defects these tests found, and fixed

These surfaced because the tests run against real infrastructure rather than mocks.

1. **IPv6 SSRF bypass (pre-existing, Phase 3).** `URL.hostname` returns an IPv6 literal wrapped in
   brackets, so `net.isIP("[::1]")` returned 0, both IP guards were skipped, and the address fell
   through to DNS resolution. `http://[::1]/`, `http://[fd00::1]/` and every other IPv6 target
   reached the crawler. Fixed by stripping brackets before every check and never resolving an IP
   literal. Regression test in `src/discovery/scope.test.ts`.
2. **Every BullMQ queue was broken (pre-existing, Phases 2-4).** BullMQ v5 rejects `:` in a custom
   job id, and all five queues used `prefix:uuid`. No job could ever be enqueued. Fixed to
   `prefix-uuid`.
3. **The local-fixture escape hatch was unusable (pre-existing, Phase 3).** The port policy rejected
   the fixture port before the documented loopback exception was considered, so
   `DISCOVERY_ALLOW_LOCAL_FIXTURE` could never work. The production policy (80/443 only) is
   unchanged; the exception now covers the port as well, and only on loopback.
4. **Collection endpoints answered `200 []` for another tenant's test run.** No data leaked, but it
   was inconsistent with every other endpoint. They now verify parent ownership and return 404.
5. **A policy-failing automation program was stored as an unapprovable draft** instead of being
   rejected with 422.
6. **`AIProviderError` used the detail as the message**, hiding the error code from logs and worker
   failure records.
7. **Failure classification missed Playwright's real browser-closed message**, which would have
   reported an infrastructure crash as a product defect.
8. **A web-first assertion against a missing element was classified `ASSERTION_FAILED`**, so healing
   was never offered for it. The category is now decided from the recorded match count rather than
   from Playwright's prose.
9. **The runner ignored the run's `recordVideo` and `captureTrace` settings.**
10. **The test setup file shadowed `.env`**, because it filled in placeholders before `dotenv` ran
    and `dotenv` never overwrites an existing variable.
11. **Unbounded JSON schemas let constrained decoding run away.** The schemas handed to the model
    had no `maxItems`, so an array had no reason to terminate and every call generated until it hit
    the 8192-token ceiling. On CPU-only hardware at ~7 tok/s that is roughly twenty minutes per
    call and looked exactly like a hang. Bounding the arrays cut a real automation generation from
    2460+ tokens to 200. Fixed in `ai/prompt.ts` and `automation/program.ts`.
12. **No stall watchdog on the AI stream.** A provider that went quiet mid-stream pinned the worker
    and its queue slot until the full request timeout. `AI_STREAM_STALL_TIMEOUT_MS` now aborts a
    stream that produces no chunk for two minutes, separately from the overall deadline.
    Regression test: `src/ai/stream.test.ts`.
13. **Every AI call requested 8192 output tokens** regardless of what it needed. Each call site now
    sets a ceiling matched to its job (generation 3072, automation 1536, analysis/healing 1024).
14. **The model copied `testCaseId` into `title`**, so test cases displayed as
    "TC-APPS-001 - TC-APPS-001". Prompt bumped to v3 with an explicit instruction; titles now read
    "Test successful login with valid credentials".

15. **The automation JSON Schema did not mirror its Zod schema.** Validation used a 17-arm
    discriminated union with per-action required fields; the schema handed to the decoder was a
    single flat object requiring only `action` and `description`. Decoding therefore could not
    enforce that `expectTitle` carries a `value` or that `goto` carries a `path`, so the model
    guessed - it attached a locator to `expectTitle` - and validation rejected the result after the
    generation had already been paid for. Both automation generations in a live run failed this way.
    The schema is now derived from the Zod union as `anyOf`, so an invalid step cannot be produced.
    Tests in `src/automation/program.test.ts` assert the two cannot drift apart again.
16. **Ollama's context window defaulted to 2048 tokens and truncated silently.** It applies that
    default whatever the model supports (this one supports 32768) and reports no error: a
    9000-token prompt comes back with a `prompt_eval_count` of 2050. Prompt and output share the
    window, so a 3072-token output budget was unreachable. The window is now sized per request from
    the prompt plus the output budget, and a prompt that still fills it logs
    `ai-provider.prompt_truncated`.
17. **`testCaseId` was pattern-constrained in validation but not in the grammar.** Zod required
    `^TC-[A-Z0-9-]+$`; the JSON Schema said only `type: string`. The model emitted
    `TC-Navigation-001`, every test case failed validation, and *every* generation silently spent a
    second full attempt - minutes of local compute - to recover. Found only after repair reasons
    were logged.
18. **Unbounded strings let decoding run away, the same way unbounded arrays did.** With no
    `maxLength`, a single `title` consumed an entire 300-token output budget repeating digits.
    Every string in both schemas is now length-bounded.
19. **A `maxLength` of 2000 fails to compile.** Ollama expands length bounds into grammar
    repetitions; measured against `qwen2.5:3b-instruct`, 1900 compiles and 2000 aborts the request
    with "failed to parse grammar". Two fields were `max(2000)` in Zod, so emitted lengths are now
    capped below that. Bounds may only ever be stricter than validation, never looser.
20. **`prefixItems` and `contains` are accepted but ignored.** Rules like "the first step must be a
    navigation" and "the program must assert something" cannot be expressed in the grammar at all.
    They are checked after decoding and routed back through the repair loop, so a policy violation
    costs one repair round instead of failing the run.
21. **Every malformed resource id returned HTTP 500.** Id columns are `@db.Uuid`, so a non-UUID
    value made Prisma throw "Error creating UUID", which fell through to the catch-all handler. A
    bad URL - or a frontend putting `undefined` in a path - produced an internal server error for
    what is simply a missing resource, and a routine bad request was logged as a server fault. A
    UUID param guard is registered on the app *and* on each mounted router, because Express resolves
    `param` handlers on the router that owns the route. Tests in
    `src/testing/malformed-id.integration.test.ts`.
22. **An unmatched `/api/v1` path returned an HTML error page** to a JSON client, because nothing
    handled it before Express's default handler.
23. **Five frontend pages bypassed the shared shell**, so the sidebar disappeared on them. They also
    bypassed the typed API client and used raw anchors, forcing a full page reload per navigation.
    Individually: the AI-analysis page returned its polling cleanup from inside a promise callback
    instead of from the effect, so **the 2.5 s interval was never cleared** and kept running after
    navigation, and any failed load left it stuck on "Loading" forever; the test-case list swallowed
    errors with `.catch(() => undefined)` and rendered "no test cases" when the request had actually
    failed; and the new-run form made the **custom viewport option permanently unsubmittable**,
    because the API requires `customViewport` dimensions the form never collected.
24. **A repair round was invisible.** A two-attempt success and a one-attempt success looked
    identical except for a doubled duration, which is what hid defect 17. Every AI call site now
    logs its request, response, and each rejection reason.

25. **Raising the step floor to one produced test cases that verify nothing.** Bounding the schema
    made generation four times faster, but with `minItems: 1` the model satisfied it minimally: every
    case became a single step, "Open the About page", whose expected result was "the Home link is
    functional". It never clicked the link. The generated automation then faithfully reproduced that
    - `goto /about`, `expectVisible`, `expectUrl contains /products` with no click in between - and
    the execution failed on an assertion that could never have passed. The engine behaved correctly
    throughout; the content was worthless. The floor is now three steps, the smallest number that can
    express navigate, act, and verify, and the prompt (v5) states that a case whose only step opens a
    page verifies nothing.

26. **Screenshots never displayed in the UI.** The artifact viewer loads a signed URL into an
    `<img>`, but the API is a different origin to the frontend and helmet's default
    `Cross-Origin-Resource-Policy: same-origin` makes the browser refuse to render it - the only
    evidence was `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` in the console and a broken image. The
    download response now sets `cross-origin-resource-policy: cross-origin`, which is safe precisely
    because the bytes are already gated: reaching that line requires a valid, unexpired,
    tenant-matched HMAC token, and the header permits display, not reading. Set on that one response,
    never globally. Only a real browser could find this - every API-level test passed throughout.

27. **Generated automation padded itself with duplicate assertions.** A three-step test case became
    a twenty-step program, eighteen of them near-duplicate `expectText` steps asserting the same text
    five times over - the array ceiling was the only thing that stopped it. The run then failed
    `LOCATOR_AMBIGUOUS`, which was a *correct* detection (`getByText('Sign in')` matches several
    elements) on a program that should never have been stored. Policy now rejects a program that
    makes the same assertion three or more times, and the rejection is routed through the repair loop
    so the model is told to fix it. A repeated *action* is still allowed - clicking through pagination
    is legitimate - only repeated assertions are flagged. Automation prompt bumped to v2.

28. **`sourceElementId` demanded a UUID the model could not produce.** `z.string().uuid()` yields a
    Zod check of kind `uuid`, which the schema converter did not translate, so the grammar allowed any
    string and a 3B model wrote `element-1` instead of a 36-character id. Both automation generations
    in a run exhausted every repair attempt on `sourceElementId: Invalid uuid`. Constraining the
    grammar to a UUID pattern would have been worse - the model would then emit a syntactically valid
    id pointing at nothing, turning a loud failure into a silent dangling reference. Elements are now
    addressed by short ref (`e3`) exactly as in the generation prompt, the worker resolves each ref to
    the real id before storing, and an invented ref resolves to null. Element UUIDs no longer appear
    in the prompt at all.

    This one had been noticed and waved through: the unbounded-string test carried an explicit
    exemption for `sourceElementId` on the grounds that it was "a nullable uuid carried straight from
    the crawl, not free text". The exemption was the defect.

29. **A passing execution captured no screenshot at all.** `recordVideo` and `captureTrace` were
    read from the run configuration but `captureScreenshots` never was, so screenshots happened only
    on an explicit `screenshot` step or on failure. The first execution that genuinely passed produced
    TRACE, HAR, CONSOLE_LOG and NETWORK_LOG and no visual evidence whatsoever - nothing to show a
    reviewer that the run was good, and nothing for a visual baseline to be seeded from. A clean run
    now captures a final full-page screenshot, asserted in the pipeline integration test.

### Not verified

- Container-level CPU, memory, disk, and pid limits (needs a container runtime).
- Visual comparison against live executions. The comparison engine is unit-tested with generated
  PNGs, but the API path has not been driven end to end.
- Load, autoscaling, and backpressure behaviour.

To reproduce the verification:

```bash
npm run db:status
npm --prefix backend run test
npm --prefix backend run test:integration
npm run typecheck && npm run lint && npm run build
```

## MVP Success Criteria

The MVP is complete when a user can securely sign up, join an organization, create a project,
submit an allowed URL, observe a bounded crawl, review AI-generated test cases, approve versioned
automation, run it in an isolated worker, inspect real results and private artifacts, review
failure analysis, create a bug, review visual diffs, and export a report.

Every path above is implemented, and all of them except the visual-diff review have been driven
end to end against live infrastructure.

## Deferred After MVP

- [ ] SSO/SAML and advanced MFA administration.
- [ ] Multi-region active-active deployment.
- [ ] Advanced billing and usage-based invoicing.
- [ ] Broad third-party integrations and hosted test environments.
- [ ] Advanced AI fine-tuning and organization-specific models.
- [ ] CI/CD triggers, scheduled runs, and webhook integrations.

These are deferred features, not missing foundations. Their extension points remain compatible with
the MVP contracts.

## Dependency Direction

```text
Frontend -> API contracts -> control-plane application modules
                                      |
                         repositories / outbox / policies
                                      |
                          PostgreSQL, Redis, object storage

Queue handlers -> isolated worker runtime -> application services
```

Controllers never contain business logic. Workers re-verify tenancy and version before processing,
so a tampered or replayed job payload cannot reach another organization. All schema changes use
migrations, all generated output is schema-validated, and all configuration comes from validated
environment sources.
