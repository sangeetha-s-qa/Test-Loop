import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server";
import { cleanUpOrganization, databaseReachable, signUp, type Agent } from "./harness";

/**
 * Every resource id is a `@db.Uuid` column, so a malformed id cannot be represented in Postgres at
 * all: Prisma throws "Error creating UUID" and the request used to fall through to the catch-all
 * handler as a 500. A frontend that put `undefined` in a path - or anyone typing a URL - got an
 * internal server error for what is simply a missing resource, and the fault was logged as a server
 * error rather than a bad request.
 *
 * These run against the real app across every mounted router, because Express resolves `param`
 * handlers on the router that owns the route: registering the guard on the app alone would leave
 * each router still returning 500, and only an end-to-end assertion catches that.
 */
describe("malformed resource ids", () => {
  let user: Agent;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    user = await signUp(app, "malformed");
  });

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
  });

  // One route per router, so a router that never registered the guard fails here.
  const routes = [
    "/api/v1/projects/undefined",
    "/api/v1/test-runs/undefined",
    "/api/v1/test-runs/undefined/discovery",
    "/api/v1/test-runs/undefined/discovery/map",
    "/api/v1/test-runs/undefined/test-cases",
    "/api/v1/test-runs/undefined/ai-status",
    "/api/v1/test-runs/undefined/automation",
    "/api/v1/test-runs/undefined/automation/status",
    "/api/v1/test-runs/undefined/executions",
    "/api/v1/executions/undefined",
    "/api/v1/artifacts/undefined/url",
    "/api/v1/bugs/undefined",
    "/api/v1/projects/undefined/report",
  ];

  it.each(routes)("%s answers 404 rather than 500", async path => {
    const response = await user.get(path);
    expect(response.status).toBe(404);
    expect(response.body?.error?.code).toBe("NOT_FOUND");
  });

  it("still resolves a well-formed id that simply does not exist", async () => {
    const response = await user.get("/api/v1/test-runs/00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(404);
  });

  it("answers an unmatched API path with JSON, not an HTML error page", async () => {
    const response = await user.get("/api/v1/there-is-no-such-route");
    expect(response.status).toBe(404);
    expect(response.body?.error?.code).toBe("NOT_FOUND");
  });

  it("does not leak the underlying database error", async () => {
    const response = await user.get("/api/v1/test-runs/not-a-uuid");
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toMatch(/prisma|uuid|invocation/i);
  });
});
