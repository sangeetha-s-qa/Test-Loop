# Testloop

An AI-assisted QA automation platform: point it at a URL, let it crawl the application, generate
reviewable test cases, turn approved cases into executable automation, run that automation in a
real browser, and keep the evidence.

The pipeline is:

```text
URL -> discovery -> application map -> AI analysis -> test cases -> review/approval
    -> automation generation -> policy validation -> approval
    -> real browser execution -> screenshots/video/trace/logs
    -> failure analysis -> self-healing proposals -> bugs -> visual baselines -> reports/export
```

Each stage is gated on the previous one having genuinely completed. Nothing reports a pass unless
a browser actually passed it, and no aggregate number in the UI is a placeholder.

Alongside it, a **manual testing** workflow generates test cases that a person executes in a
controlled browser window, recording results, screenshots, and a final report.

## Project structure

```text
TestLoop/
├── frontend/              Next.js web app (UI) - http://localhost:3000
│   ├── src/app/           routes (pages); manual testing under test-runs/[id]/manual
│   ├── src/components/    shared UI; manual testing pieces in components/manual
│   └── src/lib/           typed API client and hooks
├── backend/               Express control plane + BullMQ workers - http://localhost:4000
│   ├── prisma/            schema.prisma and migrations
│   ├── src/<module>/      one folder per domain: discovery, ai, automation, execution,
│   │                      analysis, audit, matrix, visual, reporting, manual, ...
│   ├── src/testing/       integration-test harness and suites
│   ├── artifacts/         private evidence storage (gitignored)
│   └── .env               local configuration (gitignored, never commit)
├── docs/                  architecture, roadmap, discovery policy
│   └── requirements/      technical delivery requirements
├── icons/                 product icon (testloop-icon.svg)
├── design/                UI concept artwork
├── scripts/               stack.ps1 - start/stop/status of the built production stack
├── logs/                  local run logs (gitignored)
├── docker-compose.yml     PostgreSQL, Redis, MinIO for local development
└── package.json           root scripts that drive both apps (npm run dev, test, ...)
```

All commands below run from this `TestLoop/` folder.

## Team and bug workflow

Owners and admins invite people from **Team** with a one-time link (valid 7 days) that sets their
role and team (QA, Developer, Product, Design). Bugs are raised from failed manual test cases (one
at a time or all at once from the run report) or from failed automated executions, and move through:

```text
New -> Assigned -> In progress -> Fixed -> Ready for retest -> Verified -> Closed
        ^                                         |              |         |
        +---------------- Reopened <--------------+--------------+---------+
side exits: Rejected (not a bug) · Deferred · Duplicate
```

The rules live in `backend/src/bugs/workflow.ts`. Developers work only the bugs assigned to them
(start, fix with a required description, send for retest); QA, product, and admins triage (severity,
priority, due date), assign, verify, and close. Whoever was assigned a fix can never verify it.
Assignments, retests, reopenings, and comments raise in-app notifications (the bell in the header).

Bugs have three views (**List · Board · Tracking**):

- **Board** (`/bugs/board`) - Kanban columns New, Assigned, In progress, Fixed, Ready for retest, Done
  (and Parked on request). Drag a card to move it; only columns the viewer may legally move to light
  up, and moves that need input (assignee, fix description, reason) open a dialog. Every card also
  has a keyboard **Move** menu. Optional swimlanes per assignee; refreshes every 20 seconds.
- **Tracking** (`/bugs/tracking`) - open, P1, critical, overdue, and unassigned counts; median time
  to fix and to retest; reopen rate; raised vs resolved per day; open bugs by age; workload per
  person by priority; bugs by status and severity; overdue and oldest-open lists. Every chart has
  a table view. Metrics are computed in `backend/src/bugs/metrics.ts` from stored bugs and their
  history.

## Prerequisites

| Dependency | Version | Purpose |
| --- | --- | --- |
| Node.js | 20+ | API, workers, frontend |
| PostgreSQL | 15+ | System of record |
| Redis or Memurai | 7+ | BullMQ job dispatch |
| Playwright browsers | pinned by `playwright` | Crawling and execution |
| Ollama *(optional)* | 0.3+ | Local AI provider — no paid API key needed |

## Setup

1. **Install dependencies**

   ```bash
   npm install
   npm --prefix backend install
   npm --prefix frontend install
   npm --prefix backend exec playwright install chromium firefox webkit
   ```

2. **Create the database**

   ```bash
   createdb qa_platform
   ```

3. **Configure the backend**

   Copy `backend/.env.example` to `backend/.env` and fill in real values. At minimum set
   `DATABASE_URL` and a `SESSION_SECRET` of at least 32 characters:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

   `.env` is gitignored. Never commit it and never put a real password in documentation.

4. **Apply migrations**

   ```bash
   npm --prefix backend exec prisma migrate deploy -- --schema prisma/schema.prisma
   npm --prefix backend exec prisma generate  -- --schema prisma/schema.prisma
   ```

5. **Set up the AI provider (local, free)**

   ```bash
   winget install Ollama.Ollama      # or: https://ollama.com/download
   ollama pull qwen2.5:3b-instruct
   ```

   Then in `backend/.env`:

   ```ini
   AI_PROVIDER=ollama
   AI_MODEL=qwen2.5:3b-instruct
   OLLAMA_BASE_URL=http://localhost:11434
   ```

   **Pick the model to match your hardware.** Check where Ollama is actually running the model
   with `ollama ps` - a `100% CPU` placement is far slower than a GPU one.

   | Model | Size | Suitable for |
   | --- | --- | --- |
   | `qwen2.5:3b-instruct` | ~1.9 GB | 8 GB RAM, CPU-only. The default. |
   | `qwen2.5:7b-instruct` | ~4.7 GB | 16 GB+ RAM, or any discrete GPU. |

   Measured on an 8-core CPU-only machine with 7.8 GB RAM, generating a 20-item JSON list:
   the 3B model returned valid JSON in **37 s**; the 7B model had produced nothing after
   **308 s**. A 7B model needs ~5.1 GB resident, which leaves almost nothing on an 8 GB machine.
   Schema validity does not depend on model size - Ollama constrains decoding to the JSON Schema
   either way, and every response is validated against Zod before it is persisted.

   With `AI_PROVIDER=ollama` every model call goes to localhost and **no external service is
   contacted**. `openai` and `anthropic` adapters remain available if you would rather use them;
   they need `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. `Settings` in the UI reports whether the
   configured provider is actually reachable and whether the model is installed — it never
   fabricates a working provider.

## Running

```bash
npm run dev                              # frontend + API
npm --prefix backend run workers    # all five workers together
```

Or run workers individually:

```bash
npm --prefix backend run worker:discovery
npm --prefix backend run worker:ai-generation
npm --prefix backend run worker:automation
npm --prefix backend run worker:execution
npm --prefix backend run worker:analysis
npm --prefix backend run worker:audit
```

Frontend: <http://localhost:3000> · Control plane health: <http://localhost:4000/health>

A local fixture application is available for testing the crawler and runner without touching a
third-party site:

```bash
npm --prefix backend run fixture     # http://127.0.0.1:4317
```

Set `DISCOVERY_ALLOW_LOCAL_FIXTURE=true` and `EXECUTION_ALLOW_LOCAL_FIXTURE=true` to allow
loopback targets. **Keep both false in production** — they are the only exception to the SSRF
policy that otherwise blocks loopback, private, link-local, and cloud-metadata addresses.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. PostgreSQL connection string. |
| `SESSION_SECRET` | — | Required, 32+ characters. |
| `AUTH_EMAIL_OTP_ENABLED` | `false` | **Archived by default.** `true` turns on emailed one-time codes for sign-up verification, every sign-in, and forgot-password. Off, sign-in is email + password and password reset is unavailable. |
| `SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASSWORD` / `_FROM` | unset / `587` / `false` | Only needed when `AUTH_EMAIL_OTP_ENABLED=true`. Emails the one-time codes for sign-up verification, every sign-in, and password reset. Gmail and Outlook need an app password. Unset, those endpoints answer `EMAIL_NOT_CONFIGURED`. |
| `OTP_TTL_SECONDS` / `_MAX_ATTEMPTS` / `_RESEND_COOLDOWN_SECONDS` / `_MAX_PER_HOUR` | `600` / `5` / `60` / `8` | Code lifetime, wrong guesses before lock, wait between resends, codes per account per hour. |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ connection. |
| `PORT` / `FRONTEND_URL` | `4000` / `http://localhost:3000` | CORS origin comes from `FRONTEND_URL`. |
| `DISCOVERY_MAX_PAGES` / `_DEPTH` / `_DURATION_SECONDS` | `50` / `3` / `300` | Crawl budget. |
| `DISCOVERY_MAX_REDIRECTS` / `_RESPONSE_BYTES` | `5` / `5000000` | Crawl safety limits. |
| `DISCOVERY_ALLOW_LOCAL_FIXTURE` | `false` | Loopback crawl targets. Development only. |
| `AI_PROVIDER` | unset | `ollama` \| `openai` \| `anthropic` \| `mock`. Unset disables AI features cleanly. |
| `AI_MODEL` | provider default | e.g. `qwen2.5:3b-instruct`. See the model sizing table above. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local provider endpoint. |
| `AI_REQUEST_TIMEOUT_MS` | `600000` | Overall ceiling for one model call. |
| `AI_STREAM_FIRST_CHUNK_TIMEOUT_MS` | `600000` | Budget for the *first* token. A local model evaluates the whole prompt and compiles the JSON grammar before emitting anything, which on CPU-only hardware legitimately takes minutes. |
| `AI_STREAM_STALL_TIMEOUT_MS` | `60000` | Budget *between* chunks once output has started. A healthy stream emits several times a second, so a gap here really does mean the provider died. Kept separate from the first-token budget because applying this one before any output exists aborts healthy requests. |
| `AI_MAX_CONTEXT_TOKENS` | `8192` | Ceiling on the local context window. Ollama defaults to 2048 tokens regardless of what the model supports and truncates silently; prompt and output share the window, so it is sized per request up to this ceiling. Lower it on a low-memory host — a larger window costs RAM for the KV cache. |
| `AI_MAX_PAGES` / `_ELEMENTS_PER_PAGE` / `_MAX_TEST_CASES` | `50` / `100` / `100` | Global prompt and output ceilings. A test run's own `maxTestCases` applies below these. |
| `AUTOMATION_MAX_STEPS` | `60` | Maximum steps in a stored automation program. |
| `EXECUTION_ARTIFACT_DIR` | `./artifacts` | Private artifact storage root. |
| `EXECUTION_MAX_DURATION_SECONDS` | `300` | Hard per-execution ceiling. |
| `EXECUTION_STEP_TIMEOUT_MS` | `15000` | Per-step timeout. |
| `EXECUTION_CONCURRENCY` | `2` | Parallel browser executions per worker. |
| `EXECUTION_ALLOW_LOCAL_FIXTURE` | `false` | Loopback execution targets. Development only. |
| `MANUAL_ACTION_TIMEOUT_SECONDS` | `600` | How long a run waits for a person on a `pauseForUser` step. **Keep this below the target application's own session timeout.** A pause holds the browser context open; if the application logs the run out while it waits, the resumed run fails on the next step and that failure looks like a defect in the application rather than an expired wait. |
| `MANUAL_ACTION_POLL_INTERVAL_MS` | `2000` | How often the worker re-reads its own pause row. The exchange goes through PostgreSQL rather than process memory, so a wait survives a worker restart. |
| `MANUAL_ACTION_MAX_EXTENSIONS` | `2` | How many times a person may push the deadline out before the run is abandoned. |
| `MANUAL_ACTION_SWEEP_INTERVAL_MS` | `60000` | How often a worker clears pauses orphaned by a worker that died mid-wait. Without the sweep those rows hold concurrency budget forever. |
| `AUDIT_MAX_PAGES` / `_PAGE_TIMEOUT_MS` / `_CONCURRENCY` | `20` / `30000` / `2` | Page-audit sweep budget. |
| `AUDIT_ALLOW_LOCAL_FIXTURE` | `false` | Loopback audit targets. Development only. |
| `AUDIT_PERF_LCP_MS` / `_FCP_MS` / `_TTFB_MS` / `_TBT_MS` | `2500` / `1800` / `800` / `300` | Default performance budgets. A run stores the thresholds it used, so a later report says what a number was judged against. |
| `DISCOVERY_MAX_ENDPOINTS` | `100` | Endpoint inventory cap per crawl. A single-page application can fire hundreds of XHRs. |
| `AUDIT_MAX_ENDPOINTS` / `_ENDPOINT_TIMEOUT_MS` | `40` / `10000` | API probe sweep budget. |
| `MATRIX_MAX_CELLS` | `9` | Cells in one matrix replay. Three browsers by three viewports is nine full runs of the suite, so cost grows multiplicatively. |
| `MANUAL_ACTION_MAX_CONCURRENT` | `3` | Simultaneously paused runs per organization. Each one occupies a worker slot and its browser's memory for as long as a human takes, so without a ceiling one user starves the pool. |

## Testing

```bash
# Unit and browser tests — no database required
npm --prefix backend run test

# Integration tests — needs PostgreSQL, Redis, and Playwright browsers.
# Stop the local stack first: the suite enqueues real BullMQ jobs, and a running worker will
# consume them out from under the test, producing failures that look like product defects.
pwsh scripts/stack.ps1 stop
npm --prefix backend run test:integration

# Static checks
npm run typecheck
npm run lint
npm run build

# Prisma
npm --prefix backend exec prisma validate       -- --schema prisma/schema.prisma
npm --prefix backend exec prisma migrate status -- --schema prisma/schema.prisma
```

The integration suite creates its own organizations and deletes them afterwards, so it does not
disturb existing local data.

## Limitations

- **Artifact storage is a local directory.** `backend/src/artifacts/storage.ts` is a narrow
  put/get/delete interface deliberately shaped like S3, but the shipped driver writes to disk.
  Downloads still go through short-lived HMAC-signed tokens with an authorization check at minting.
- **Artifact retention is not automated.** Deleting a project or organization cascades the database
  rows, but the files under `EXECUTION_ARTIFACT_DIR` are left behind. `deleteExecutionObjects()`
  exists for this and is not yet wired to a lifecycle job, so the directory grows until it is
  cleaned up by hand. Quotas and expiry (`ExecutionArtifact.expiresAt`) are modelled but not
  enforced.
- **Workers are processes, not containers.** They are isolated from the API process and clean up
  browsers and temporary directories, but the per-job CPU/memory/disk/pid limits described in
  docs/ARCHITECTURE.md section 12 need a container runtime that is not part of this setup.
- **Execution enforces a strict same-origin egress policy.** During a run, every network request is
  re-checked and anything off the approved origin is aborted. This is deliberate — it is the
  egress restriction the roadmap requires — but it means a target application that loads fonts,
  scripts, or images from a CDN will render without them. Assertions about page structure and text
  still work; assertions about third-party widgets will not. Loosening this needs a per-project
  allowlist, which is not implemented.
- **A small local model is slower and weaker than a hosted frontier model.** On CPU-only hardware
  an AI stage takes tens of seconds to minutes, generation may need repair attempts, and generated
  automation should be reviewed rather than rubber-stamped. Schema validation and policy validation
  apply identically regardless of provider, so a weak model produces *fewer or rejected* results,
  never invalid ones. If the model cannot produce a usable program, author one by hand through
  `POST /api/v1/test-cases/:id/automation/manual` - the platform is fully usable without AI.
- **Ollama requests are streamed.** A non-streaming request to a slow local model trips undici's
  own 300 s header timeout underneath `fetch`, regardless of `AI_REQUEST_TIMEOUT_MS`. Streaming
  makes headers arrive immediately, so the configured timeout is the real ceiling.
- **The local context window is set explicitly per request.** Ollama defaults to a 2048-token
  window whatever the model's own limit is, and it truncates over-long prompts *silently* — a
  9000-token prompt reports a `prompt_eval_count` of 2050 with no error. Because the prompt and the
  generated output share that window, leaving it at the default also caps output regardless of the
  requested budget. The provider sizes the window from the prompt plus the output budget, up to
  `AI_MAX_CONTEXT_TOKENS`, and logs `ai-provider.prompt_truncated` if a prompt still fills it.
- **Constrained decoding has limits that are easy to mistake for model weakness.** Ollama compiles
  the JSON Schema into a grammar, and three properties of that compilation matter. An *unbounded*
  rule gives the decoder no reason to stop - an unbounded array once ran generation to the full
  output ceiling, and an unbounded string did the same one field at a time (a probe produced a single
  `title` that consumed a whole 300-token budget). A *too-large* bound fails to compile at all:
  `maxLength` of 1900 works and 2000 aborts the request with "failed to parse grammar", so the
  automation schema caps emitted string lengths below the Zod maxima. And `prefixItems` and
  `contains` are *accepted but silently ignored*, so "the first step must be a navigation" and "the
  program must assert something" cannot be enforced by the grammar; those are checked after decoding
  and fed back through the repair loop instead. Every schema here is therefore fully bounded, and
  bounds may only ever be stricter than validation, never looser.
- **A paused run holds a browser open.** When a test reaches a `pauseForUser` step the execution
  suspends with its context and session intact and waits for a person. That slot and its memory are
  occupied for the whole wait, which is why `MANUAL_ACTION_MAX_CONCURRENT` exists. The deadline
  sweep (`expireOverdueManualActions`) is implemented but is not yet wired to a scheduled job, so a
  pause orphaned by a killed worker is only cleared the next time something calls it.
- **Annotations are stored as vectors, never painted into the screenshot.** The original artifact is
  never rewritten, so it keeps its recorded checksum. The consequence is that there is no flattened
  image to hand to someone outside the platform yet — compositing the overlay onto a copy is part of
  the unbuilt report-export work. Only rectangles are drawable today.
- **API probing only ever calls GET, HEAD and OPTIONS.** A POST, PUT, PATCH or DELETE observed
  during a crawl is listed as inventory and never replayed — repeating one could create an order or
  delete a record. Probes are anonymous, so results describe what an unauthenticated caller can
  reach, not what a signed-in user sees. There is no schema assertion: a JSON response is checked
  for parseability, not against a contract.
- **A matrix replay cannot tell a flake from a real cross-browser difference.** A cell that errored
  or timed out is reported as inconclusive rather than as a browser bug, but a genuine-looking
  single-cell failure can still be intermittent. Confirming means re-running the grid — there is no
  automatic re-run of only the diverging cells. Comparison is by verdict, not by pixels.
- **Audits are lab measurements, not field data.** Performance numbers come from one cold load in a
  headless browser on the machine running the worker. They are comparable between runs; they are not
  what a visitor on a real connection sees. Largest-contentful-paint and total blocking time are
  Chromium-only — Firefox and WebKit report those metrics as absent rather than as a wrong number.
- **Security auditing is observation only.** Headers, cookie attributes, mixed content and transport.
  Nothing sends an injection payload, attempts an authentication bypass, or fuzzes an endpoint.
- **The egress allowlist waives the same-origin rule and nothing else.** Every entry still passes the
  full SSRF check at request time, so a private, loopback or cloud-metadata address cannot be
  allowlisted into reach. Without an allowlist a performance audit measures a page rendered without
  its CDN, which is not the page anyone visits.
- **A pause captures no screenshot.** Artifacts are written after the browser context closes, so
  capturing one mid-run needs the artifact path reworked. The dialog shows the page URL instead.
- **No SSO/SAML, MFA administration, or multi-region deployment.** These are explicitly deferred
  in the roadmap.
- **Visual comparison is pixel-based** (`pixelmatch`) with rectangle masks. Perceptual comparison
  is not implemented.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and boundaries
- [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md) — phase-by-phase status
- [`docs/DISCOVERY.md`](docs/DISCOVERY.md) — crawler and SSRF policy
