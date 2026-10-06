import type { IRouter, NextFunction, RequestHandler, Response } from "express";
import type { AuthRequest } from "./middleware/auth";

/** Single shape for every error response. Never carries a stack trace, host, or provider detail. */
export function fail(response: Response, status: number, code: string, message: string) {
  return response.status(status).json({ error: { code, message } });
}

export const notFound = (response: Response, message = "Resource not found") => fail(response, 404, "NOT_FOUND", message);
export const forbidden = (response: Response, message = "You do not have permission to perform this action") => fail(response, 403, "FORBIDDEN", message);
export const conflict = (response: Response, code: string, message: string) => fail(response, 409, code, message);
export const badRequest = (response: Response, code: string, message: string) => fail(response, 400, code, message);

/**
 * Wraps an async route so a rejected promise reaches the Express error handler instead of
 * becoming an unhandled rejection. Express 5 forwards rejections itself, but routes registered
 * before the error middleware still need the explicit `catch` for consistent status codes.
 */
export function route(handler: (request: AuthRequest, response: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (request, response, next) => {
    handler(request as AuthRequest, response, next).catch(next);
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every path parameter in this API identifies a row keyed by a `@db.Uuid` column. */
const uuidParams = ["id", "projectId", "caseId"] as const;

/**
 * Rejects a malformed resource id before it reaches Prisma.
 *
 * The id columns are `@db.Uuid`, so Postgres cannot even represent a non-UUID value: Prisma throws
 * "Error creating UUID" and the request lands in the catch-all handler as a 500. A client that
 * simply asked for a nonexistent resource - or a frontend that put `undefined` in the path - then
 * sees an internal error instead of a not-found, and a routine bad request is logged as a server
 * fault. A malformed id provably identifies no row, so it is answered exactly like any other
 * missing resource.
 *
 * Applied per router because Express resolves `param` handlers on the router that owns the route,
 * so registering only on the app would leave every mounted router still returning 500.
 */
export function registerUuidParams(router: IRouter) {
  for (const name of uuidParams) {
    router.param(name, (_request, response, next, value) => {
      if (typeof value === "string" && UUID_PATTERN.test(value)) return next();
      return notFound(response, "Resource not found");
    });
  }
}

/** Roles allowed to change state. VIEWER is read-only everywhere. */
export const canWrite = (role: string) => role === "OWNER" || role === "ADMIN" || role === "MEMBER";
/** Roles allowed to approve generated artifacts and healing proposals. */
export const canApprove = (role: string) => role === "OWNER" || role === "ADMIN" || role === "MEMBER";
