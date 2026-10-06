# Testloop Architecture

## 1. Architecture Goals and Scope

This document defines the MVP foundation for a production-oriented, multi-tenant AI QA automation SaaS. The MVP uses a modular monolith for the control plane and isolated worker processes or containers for untrusted crawling and browser execution.

The platform must provide real execution and evidence. AI output is assistive and versioned; it is never authoritative without validation or user policy. Long-running work is asynchronous, tenant-scoped, observable, cancellable, and recoverable.

## 2. Final Architecture Overview

```text
Next.js frontend
        |
HTTPS API and realtime event gateway
        |
Modular monolith control plane
  Auth and tenancy | Projects and tests | AI orchestration
  Crawl orchestration | Execution orchestration | Artifacts
  Bugs, reports, integrations, audit
        |
  PostgreSQL + Prisma       Redis + BullMQ
  S3-compatible storage     Secret manager
        |
Isolated execution plane
  Crawler workers | Playwright runners | Visual/report workers
```

The API, database, queue orchestration, authorization, and metadata remain in the control plane. Crawler and Playwright jobs run in disposable, least-privileged worker processes or containers and never execute inside the API process.

## 3. Technology Choices

### Control plane

- Next.js 14+ and React with TypeScript strict mode
- Tailwind CSS and shadcn/ui
- Node.js, Express, and TypeScript modular monolith
- REST API with OpenAPI contract and generated/shared TypeScript types
- SSE or WebSockets for persisted job events and reconnectable progress
- PostgreSQL with Prisma migrations
- Redis with BullMQ for asynchronous jobs, rate limits, and short-lived cache data
- S3-compatible object storage for artifacts
- Secret manager for provider, integration, and environment credentials

### Execution plane

- Pinned Playwright browser images
- Disposable crawler and test-runner workers
- Separate worker pools and queues by workload type
- Network egress proxy or isolated network policy
- Resource, time, disk, and process limits per job

## 4. Control Plane Modules

The backend is a modular monolith with explicit domain ownership:

```text
src/modules/
  auth/tenancy/authorization/
  projects/requirements/
  discovery/                  # crawl orchestration and snapshots
  test-design/                # scenarios, cases, approvals
  automation/                 # scripts, versions, validation, healing proposals
  ai/                         # providers, prompts, schemas, cost and policy
  execution/                  # runs, state machine, orchestration
  artifacts/                  # object metadata and signed access
  visual/                     # baselines and comparisons
  bugs/reports/integrations/
  audit/observability/
src/workers/
  crawler.worker.ts
  execution.worker.ts
  ai.worker.ts
  visual.worker.ts
  report.worker.ts
```

Controllers validate and authorize requests. Services own business rules. Repositories own persistence. Workers call application services through job-specific handlers, and all state changes are persisted in PostgreSQL.

Cross-cutting requirements: request IDs, structured errors, API versioning, idempotency keys for mutations, configuration validation at startup, rate limiting, audit events, and no stack traces or secrets in client responses.

## 5. Tenancy, Identity, and Authorization

The organization is the tenant boundary. Every tenant-owned record includes `organizationId` directly or has an enforced relationship through a tenant-owned parent. Every request resolves an authenticated principal, active organization, and optional project context before service execution.

### Core identity model

```text
User
Organization
OrganizationMembership (userId, organizationId, role, status)
Project (organizationId)
ProjectMembership (projectId, userId, role) [optional for MVP, supported by policy]
Session / RefreshToken
ApiKey (hashed, scoped, revocable)
AuditEvent (organizationId, actor, action, target, metadata)
```

MVP roles are `OWNER`, `ADMIN`, `MEMBER`, and `VIEWER`. Organization and project policies are centralized and checked on every object lookup, mutation, queue request, and artifact download. No authorization relies on an ID being difficult to guess.

Authentication includes Argon2id password hashing, email verification, secure password recovery, refresh-token rotation and revocation, HttpOnly/Secure/SameSite cookies for browser sessions, CSRF protection for cookie-authenticated mutations, and optional MFA as a planned enterprise capability. API keys are scoped, hashed, displayed once, and revocable.

## 6. PostgreSQL and Prisma Design

PostgreSQL is the system of record. Prisma models use UUID or equivalent opaque IDs, UTC timestamps, foreign keys, explicit join tables, migrations, and transaction boundaries. Large logs and artifact bytes do not live in PostgreSQL.

### Primary relationships

```text
Organization
  -> Memberships, Projects, Integrations, AuditEvents, UsageRecords
Project
  -> Requirements, CrawlSnapshots, TestSuites, TestCases, TestRuns, Bugs
TestCase
  -> TestCaseVersions, AutomationScripts, AutomationVersions, Executions
TestRun
  -> JobRecords, TestExecutions, ArtifactManifests, VisualComparisons
VisualBaseline
  -> VisualBaselineVersions -> VisualComparisons
```

Important models include `User`, `Organization`, `OrganizationMembership`, `Project`, `ProjectMembership`, `Requirement`, `CrawlSnapshot`, `ApplicationPage`, `ApplicationElement`, `TestSuite`, `TestCase`, `TestCaseVersion`, `AutomationScript`, `AutomationVersion`, `TestRun`, `TestExecution`, `JobRecord`, `Artifact`, `ArtifactManifest`, `VisualBaseline`, `VisualBaselineVersion`, `VisualComparison`, `Bug`, `Integration`, `UsageRecord`, and `AuditEvent`.

JSON is limited to schema-validated, versioned data such as steps, provider metadata, locator candidates, and structured logs. Each JSON payload stores a schema version. Secrets are references to a secret manager, never raw values.

Required database behavior:

- Composite indexes for tenant/project filtering, status, and creation time.
- Unique constraints for organization membership, idempotency keys, external IDs, and active baseline identity.
- Optimistic version fields on editable test cases, automation, and baselines.
- Immutable version rows for generated or approved artifacts.
- State-transition records for jobs and test executions.
- Soft-delete or archive policy for user-visible entities.
- Retention and partition/archive strategy for high-volume executions, logs, and audit data.
- Transactional outbox records for events that must accompany database changes.

## 7. API and Realtime Contract

REST endpoints are versioned under `/api/v1`. OpenAPI is the source of truth for request/response types. All list endpoints support cursor pagination, stable ordering, filtering, and authorization-aware counts.

```text
POST /api/v1/auth/signup|login|logout|refresh
GET  /api/v1/auth/me
POST /api/v1/organizations
GET  /api/v1/organizations/:id/members
POST /api/v1/projects
GET  /api/v1/projects/:id
POST /api/v1/projects/:id/crawl
POST /api/v1/projects/:id/test-runs
GET  /api/v1/test-runs/:id
POST /api/v1/test-runs/:id/cancel
POST /api/v1/test-cases/:id/generate-automation
POST /api/v1/automation/:id/heal
POST /api/v1/projects/:id/reports
```

The API returns a job ID for long-running work. Events are persisted as job events and delivered through SSE/WebSockets. Clients can reconnect and replay events from a cursor. Authorization is checked before issuing signed artifact URLs.

## 8. Redis and BullMQ Architecture

Redis is not the system of record. PostgreSQL stores `JobRecord`, durable status, transition history, attempts, errors, and ownership. BullMQ provides dispatch, delayed work, concurrency, and short-lived coordination.

Queues:

- `crawl-application`
- `generate-ai`
- `generate-test-cases`
- `generate-automation`
- `execute-tests`
- `analyze-failures`
- `visual-comparison`
- `generate-reports`
- `heal-automation`

Each job carries `jobId`, `organizationId`, `projectId`, actor, resource version, correlation ID, and an idempotency key. Workers verify ownership and current version before processing. Jobs have explicit timeouts, exponential backoff with jitter, bounded attempts, and failure classification. Permanent failures move to a dead-letter queue and remain replayable by an authorized operator.

Cancellation sets a durable cancellation request in PostgreSQL, signals the worker, and terminates the isolated process if needed. Duplicate delivery is expected and handlers are idempotent. Per-tenant quotas, concurrency, priority, and rate limits prevent noisy-neighbor behavior. Worker heartbeats, queue depth, age, retries, failures, and dead letters are monitored.

## 9. Website Crawler Architecture

The API validates the target and creates a crawl job. An isolated crawler worker uses Playwright to produce a normalized `CrawlSnapshot`, pages, elements, accessibility data, navigation edges, response metadata, and redacted evidence.

Limits include maximum depth, pages, redirects, response size, runtime, concurrent requests, JavaScript execution time, and per-tenant request rate. The crawler follows an explicit same-origin policy by default; additional origins require allowlisting and consent policy.

SSRF controls are mandatory:

- Permit only HTTP and HTTPS and restrict ports.
- Resolve hostnames and reject loopback, private, link-local, multicast, metadata, and reserved IPv4/IPv6 ranges.
- Re-check every redirect and resolved address to prevent DNS rebinding.
- Route traffic through an egress proxy or isolated network with deny-by-default internal access.
- Block cloud metadata endpoints and host filesystem/network access.
- Never log credentials, cookies, authorization headers, or sensitive page values.

Page text, DOM content, scripts, comments, and external content are untrusted data. They are delimited and labeled as data before AI processing. They cannot change system instructions, tool permissions, tenant policy, or requested output schema. Prompt-injection detection, output validation, tool allowlists, secret redaction, and human approval protect AI workflows.

## 10. AI Provider Abstraction

```text
AIProvider
  -> OllamaProvider     # local; contacts only localhost
  -> OpenAIProvider
  -> AnthropicProvider
  -> MockProvider       # deterministic; a test must supply the response

AIOrchestrator
  -> policy/model selection
  -> prompt and schema versioning
  -> structured output request
  -> validation and repair
  -> fallback/retry/cost recording
```

The provider interface exposes capabilities, structured JSON output, optional vision, token usage, latency, model identity, request IDs, and error categories. Prompts, output schemas, and model configuration are versioned. Every result records provider, model, prompt version, schema version, input fingerprint, usage, cost, latency, and validation status.

AI outputs are validated with Zod or JSON Schema, size-limited, deduplicated, and stored as drafts with provenance. Invalid responses receive bounded repair attempts, then a fallback provider or explicit failure. Timeouts, circuit breakers, provider rate limits, tenant budgets, and data-retention policy are enforced. Cache keys include tenant policy, model, prompt version, schema version, and normalized input hash. No provider receives secrets or unnecessary personal data.

### Local AI provider

`AI_PROVIDER=ollama` routes every model call to `OLLAMA_BASE_URL` (localhost by default) and
contacts **no external service**. Ollama supports constrained decoding against a JSON Schema, which
removes most repair rounds. The provider layer is otherwise identical across adapters: the same
`generateValidated` wrapper parses, extracts JSON from prose or markdown fences, validates against
the Zod schema, and performs a bounded number of repair attempts before failing explicitly. AI
output is never persisted without passing schema validation, whatever the provider.

`checkProviderReady()` verifies the provider is reachable and, for Ollama, that the configured
model is actually installed. The API calls it before queueing AI work so a user gets an actionable
message rather than a job that fails minutes later inside a worker.

## 11. Test Design and Generation Flow

```text
URL + requirements
  -> immutable crawl snapshot
  -> normalized application model
  -> AI discovery and candidate scenarios
  -> schema validation, deduplication, coverage metadata
  -> draft test cases with provenance
  -> user review/approval
  -> immutable TestCaseVersion
  -> automation generation and validation
```

Generated test cases record source requirements, crawl snapshot, evidence references, AI metadata, confidence, and generation status. Editing creates a new version. Approval is explicit. Regeneration never overwrites an approved version.

## 11a. Automation Representation (implementation decision)

Generated automation is stored as a **validated declarative step program**, not as a code string.

```text
AutomationProgram
  schemaVersion
  name
  steps[]           # a closed discriminated union of typed actions
    goto | click | fill | select | check | press | hover
    waitForVisible | waitForUrl | screenshot
    expectVisible | expectHidden | expectText | expectValue
    expectUrl | expectTitle | expectCount
```

The Phase 5 gate requires that generated automation cannot reach host resources, secrets, or
forbidden network targets. A code string would need a sandbox to make that true. A closed set of
typed actions makes it true by construction: `src/execution/runner.ts` is the only code that drives
the browser, and it contains no `eval`, no filesystem action, and no arbitrary-URL action. `goto`
carries a path relative to the approved origin, which the runner resolves and re-checks, so
automation cannot be pointed at another host.

A readable Playwright spec is rendered from the program (`src/automation/renderer.ts`) for human
review and export. **That rendered source is never executed.** Keeping the renderer in sync with
the runner is the renderer's only responsibility, and each step maps to exactly one emitted line.

Policy validation (`src/automation/validate.ts`) runs twice: before a version is stored and again
before it executes. The second pass means a version approved before a policy change cannot run
under the old rules. It rejects programs with no assertion, programs that do not begin by
navigating, off-origin or protocol-relative navigation, bare-tag and wildcard CSS locators,
`javascript:` locators, and credential-shaped step values.

## 12. Playwright Execution Architecture

An execution worker receives an immutable test-case and automation version plus environment configuration. Generated code is parsed and policy-validated before execution. It runs in a disposable, sandboxed container with pinned browsers, no host mounts, restricted egress, isolated credentials, and resource limits.

```text
QUEUED
  -> PROVISIONING
  -> RUNNING
  -> COLLECTING_ARTIFACTS
  -> PASSED | FAILED | CANCELLED | TIMED_OUT
```

Every transition is persisted and idempotent. Worker crash recovery, duplicate jobs, cancellation, timeout, partial uploads, and infrastructure failure have defined terminal outcomes. Results include browser/version, viewport, device scale, environment, project revision, script version, duration, and structured error classification.

## 13. Artifact Storage

S3-compatible object storage holds screenshots, videos, traces, HAR/network logs, console logs, reports, and diffs. PostgreSQL stores artifact metadata and an execution-level manifest.

**Implementation status:** `src/artifacts/storage.ts` exposes a narrow put/get/delete interface
shaped exactly as an S3 driver needs, but the shipped driver writes to a private local directory
(`EXECUTION_ARTIFACT_DIR`). Swapping in object storage does not touch any caller. Object keys are
always generated server-side from tenant-owned ids and are never accepted from a client; path
resolution refuses any key that escapes the storage root. Downloads use short-lived HMAC-signed
tokens, and authorization is checked when the token is minted rather than at download time, so an
artifact URL alone never grants access to another tenant.

Object keys are generated server-side and include tenant, project, run, execution, artifact type, and version. Objects are private, encrypted, checksummed, content-type constrained, and accessed only through short-lived signed URLs after authorization. Upload completion is recorded transactionally where possible; incomplete uploads are cleaned up.

Retention, quotas, lifecycle expiration, deletion requests, encryption-key rotation, and usage accounting are mandatory. Screenshots, videos, traces, and logs may contain credentials or personal data, so redaction and configurable retention are applied before storage where feasible.

## 14. Failure Analysis and Bug Reports

Failure analysis is an asynchronous, versioned suggestion based on structured errors, steps, expected results, screenshots, trace references, console/network evidence, environment metadata, and historical context. It returns category, likely cause, confidence, evidence references, duplicate candidates, and recommended action.

AI analysis never silently changes test behavior or bug state. Users can review and create a bug. Bugs retain source execution, automation version, artifact manifest, and analysis version. Duplicate detection and bug creation are idempotent.

## 15. Visual Regression

Visual baselines are immutable, versioned, and scoped by test case, browser, viewport, device scale factor, and relevant environment. A comparison records baseline/current/diff artifacts, algorithm and threshold, masks, rendering metadata, status, approval actor, and approval history.

Dynamic regions, animations, timestamps, fonts, and random data are controlled or masked. Pixel and perceptual comparison strategies are selectable. Baseline approval creates a new version; it never overwrites history. Visual diffs are reviewable and do not automatically update baselines.

## 16. Self-Healing Automation

Self-healing is a reviewable proposal workflow:

```text
locator failure
  -> collect DOM/accessibility evidence
  -> generate ranked candidates
  -> validate candidates in the same isolated run
  -> store confidence and evidence
  -> user approval or explicit tenant policy
  -> create new AutomationVersion
```

Healing cannot change assertions, bypass authentication, broaden network access, or silently replace an approved script. Candidates that can match multiple elements are rejected. Every proposal is auditable, reversible, and subject to regression validation.

## 17. Security, Privacy, and Operations

Controls include strict validation, secure headers and CSP, WAF/API rate limits, dependency and container scanning, signed/pinned worker images, secret-manager integration, encryption in transit and at rest, key rotation, audit logging, tenant-isolation tests, and prompt-injection defenses.

Observability includes structured logs, metrics, distributed traces, correlation IDs, worker heartbeats, queue health, execution duration, AI usage/cost, artifact usage, authorization failures, and security alerts. Logs are redacted and retained according to policy.

Backups are encrypted and restore-tested. Define MVP recovery objectives, incident response, data deletion/export, retention schedules, and operational runbooks before production launch. Feature flags and gradual worker/API rollout are supported.

## 18. Scalability

API instances are stateless and horizontally scalable. Worker pools autoscale independently by queue and resource profile. PostgreSQL uses connection pooling, appropriate indexes, and archival or partitioning for high-volume execution data. Redis is highly available and used for coordination, not canonical state. Object storage handles large artifacts.

Tenant quotas, fair scheduling, backpressure, admission control, regional egress policy, and usage metering protect capacity. The architecture can later split modules into services without changing domain contracts, but the MVP remains a modular monolith.

## 19. MVP Boundary

The MVP includes one control-plane deployment, PostgreSQL, Redis/BullMQ, S3-compatible storage, isolated crawler and Playwright worker containers, OpenAI/Anthropic provider adapters, organization RBAC, core audit/observability, basic visual comparison, and reviewable self-healing proposals.

Enterprise SSO/SAML, multi-region active-active deployment, advanced billing, and broad third-party integrations are deferred, but their extension points are preserved.