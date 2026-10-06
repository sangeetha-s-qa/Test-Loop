# Phase 3 Discovery

The API creates a `QUEUED` `DiscoveryRun`; `POST /api/v1/test-runs/:id/discovery/start` dispatches the deterministic BullMQ job `discovery:<testRunId>`. Run the control plane and isolated worker separately:

```text
npm --prefix backend run dev
npm --prefix backend run worker:discovery
```

The crawler accepts only HTTP(S), ports 80/443, and same-origin URLs. Before navigation it resolves hostnames and rejects loopback, private, link-local, multicast, reserved, and cloud metadata addresses. Playwright request interception repeats this check for every request and redirect chain. The final URL is checked again after navigation. Redirect count, page count, depth, duration, and response body size are bounded.

Discovered page text, labels, accessible names, and attributes are untrusted website data. They are stored as data only; no AI or instruction processing occurs in Phase 3. Form controls are inspected but never submitted and no credentials are entered.

For local crawler tests only, set `DISCOVERY_ALLOW_LOCAL_FIXTURE=true`; this explicitly permits only `127.0.0.1` or `localhost` targets. Keep it false in production. The default remains SSRF-blocked.

Apply the migration with the real database credentials:

```text
$env:DATABASE_URL="postgresql://..."
Push-Location backend
npx prisma migrate deploy --schema prisma/schema.prisma
npx prisma migrate status --schema prisma/schema.prisma
Pop-Location
```
