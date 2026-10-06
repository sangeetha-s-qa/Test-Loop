import { describe, expect, it } from "vitest";
import { assertSameOrigin, assertSafeUrl, normalizeUrl } from "./scope";

describe("discovery URL scope", () => {
  it("normalizes fragments and trailing paths", () => {
    expect(normalizeUrl("https://example.com/products#details")).toBe("https://example.com/products");
  });

  it("rejects unsupported protocols and ports", () => {
    expect(() => normalizeUrl("ftp://example.com")).toThrow("UNSUPPORTED_PROTOCOL");
    expect(() => normalizeUrl("https://example.com:8443")).toThrow("PORT_NOT_ALLOWED");
  });

  it("rejects loopback, private, and metadata destinations before DNS", async () => {
    await expect(assertSafeUrl("http://localhost")).rejects.toThrow("DESTINATION_BLOCKED");
    await expect(assertSafeUrl("http://127.0.0.1")).rejects.toThrow("DESTINATION_BLOCKED");
    await expect(assertSafeUrl("http://10.0.0.1")).rejects.toThrow("DESTINATION_BLOCKED");
    await expect(assertSafeUrl("http://169.254.169.254")).rejects.toThrow("DESTINATION_BLOCKED");
  });

  it("rejects cross-origin URLs", () => {
    expect(() => assertSameOrigin("https://other.example/path", "https://example.com")).toThrow("CROSS_ORIGIN_BLOCKED");
  });

  it("permits a non-standard port only for a loopback fixture target", async () => {
    // Without the flag the production port policy applies, even on loopback.
    expect(() => normalizeUrl("http://127.0.0.1:4317/")).toThrow("PORT_NOT_ALLOWED");
    expect(normalizeUrl("http://127.0.0.1:4317/", undefined, { allowLocalFixture: true })).toBe("http://127.0.0.1:4317/");
    await expect(assertSafeUrl("http://127.0.0.1:4317/", undefined, { allowLocalFixture: true })).resolves.toBe("http://127.0.0.1:4317/");
  });

  it("blocks IPv6 literals, which URL.hostname reports wrapped in brackets", async () => {
    // Without stripping the brackets net.isIP returns 0, both IP guards are skipped, and the
    // address reaches DNS resolution as an unrecognised name.
    for (const url of ["http://[::1]/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[fc00::1]/", "http://[::]/", "http://[ff02::1]/"]) {
      await expect(assertSafeUrl(url), `${url} must be blocked`).rejects.toThrow("DESTINATION_BLOCKED");
    }
  });

  it("does not let the fixture flag open a non-loopback host or port", async () => {
    expect(() => normalizeUrl("https://example.com:8443/", undefined, { allowLocalFixture: true })).toThrow("PORT_NOT_ALLOWED");
    await expect(assertSafeUrl("http://10.0.0.1:8080/", undefined, { allowLocalFixture: true })).rejects.toThrow();
    await expect(assertSafeUrl("http://169.254.169.254/", undefined, { allowLocalFixture: true })).rejects.toThrow("DESTINATION_BLOCKED");
    // The exception covers loopback only; other IPv6 ranges stay blocked even with it enabled.
    await expect(assertSafeUrl("http://[fd00::1]/", undefined, { allowLocalFixture: true })).rejects.toThrow("DESTINATION_BLOCKED");
  });
});
