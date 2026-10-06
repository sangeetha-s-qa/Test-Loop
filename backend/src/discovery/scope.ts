import dns from "node:dns/promises";
import net from "node:net";

const blockedHostnames = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata.google.internal."]);

function ipv4Blocked(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
}

function ipv6Blocked(value: string) {
  const normalized = value.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff");
}

/**
 * `URL.hostname` keeps the brackets around an IPv6 literal, so "[::1]" is not a string `net.isIP`
 * recognises. Without stripping them every IPv6 address slips past both IP guards and reaches DNS
 * resolution as an unrecognised name. Every check below runs on the bare form.
 */
const bareHost = (hostname: string) => hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();

/** True for the loopback hosts the local-fixture exception covers. */
const isLoopbackHost = (hostname: string) => {
  const host = bareHost(hostname);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
};

export function normalizeUrl(raw: string, base?: string, options: { allowLocalFixture?: boolean } = {}) {
  const value = new URL(raw, base);
  if (!(["http:", "https:"].includes(value.protocol))) throw new Error("UNSUPPORTED_PROTOCOL");
  value.hash = "";
  value.username = "";
  value.password = "";
  const localFixturePort = options.allowLocalFixture && isLoopbackHost(value.hostname.toLowerCase());
  if (value.port && !localFixturePort && !(["80", "443"].includes(value.port))) throw new Error("PORT_NOT_ALLOWED");
  value.pathname = value.pathname || "/";
  return value.toString();
}

export function assertSameOrigin(target: string, origin: string) {
  if (new URL(target).origin !== new URL(origin).origin) throw new Error("CROSS_ORIGIN_BLOCKED");
}

/**
 * Parses one allowlist entry into a bare origin, rejecting anything that is not a plain http(s)
 * origin. Returns null rather than throwing so a malformed stored entry degrades to "not allowed"
 * instead of taking a whole run down.
 */
export function parseAllowedOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function assertSafeUrl(raw: string, origin?: string, options: { allowLocalFixture?: boolean; allowedOrigins?: string[] } = {}) {
  const normalized = normalizeUrl(raw, undefined, options);
  if (origin) {
    // An allowlisted origin waives the same-origin rule and *nothing else*. Every address check
    // below still runs on it, so "allowlist a CDN" can never become "allowlist 169.254.169.254":
    // the entry is matched by origin string, then the resolved address is vetted exactly as the
    // application's own origin is.
    const targetOrigin = new URL(normalized).origin;
    const allowed = options.allowedOrigins?.some(entry => parseAllowedOrigin(entry) === targetOrigin) ?? false;
    if (!allowed) assertSameOrigin(normalized, origin);
  }
  const parsed = new URL(normalized);
  const hostname = bareHost(parsed.hostname);
  const localFixture = options.allowLocalFixture && isLoopbackHost(hostname);
  if (!localFixture && (blockedHostnames.has(hostname) || hostname.endsWith(".localhost") || hostname === "169.254.169.254")) throw new Error("DESTINATION_BLOCKED");
  if (localFixture) return normalized;
  const literal = net.isIP(hostname);
  if (literal === 4 && ipv4Blocked(hostname)) throw new Error("DESTINATION_BLOCKED");
  if (literal === 6 && ipv6Blocked(hostname)) throw new Error("DESTINATION_BLOCKED");
  // An IP literal is never resolved: DNS would only reintroduce the ambiguity just eliminated.
  if (literal) return normalized;
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => net.isIP(address) === 4 ? ipv4Blocked(address) : ipv6Blocked(address))) throw new Error("DESTINATION_BLOCKED");
  return normalized;
}
