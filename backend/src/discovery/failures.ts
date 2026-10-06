/**
 * Turns a crawl failure into text that is safe to return to a client.
 *
 * Only recognised codes get a description. Anything else is reported generically, because the raw
 * error can carry internal detail: a Prisma constraint violation here embedded the absolute path of
 * a compiled source file, and that message was written straight to a column the API serves.
 */
const explanations: Record<string, string> = {
  CANCELLED: "Discovery was cancelled.",
  RESPONSE_TOO_LARGE: "A page exceeded the configured response size limit.",
  TOO_MANY_REDIRECTS: "The site redirected more times than the configured limit allows.",
  DESTINATION_BLOCKED: "The target address is not permitted. Loopback, private, link-local, and cloud-metadata addresses are blocked.",
  CROSS_ORIGIN_BLOCKED: "The page navigated to a different origin than the one this run was authorized for.",
  BROWSER_LAUNCH_FAILED: "The browser could not be started. Check that Playwright browsers are installed.",
  UNSUPPORTED_PROTOCOL: "Only HTTP and HTTPS targets are supported.",
  PORT_NOT_ALLOWED: "Only the standard HTTP and HTTPS ports are allowed.",
};

export const knownDiscoveryFailureCodes = Object.keys(explanations);

export function describeDiscoveryFailure(message: string): string {
  return explanations[message] ?? "Discovery could not be completed. The server log has the details.";
}
