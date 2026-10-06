import { describe, expect, it } from "vitest";
import { describeDiscoveryFailure, knownDiscoveryFailureCodes } from "./failures";

describe("describeDiscoveryFailure", () => {
  it.each(knownDiscoveryFailureCodes)("explains %s in plain language", code => {
    const text = describeDiscoveryFailure(code);
    expect(text).not.toBe(code);
    expect(text.length).toBeGreaterThan(10);
  });

  it("never echoes an unrecognised error back to the caller", () => {
    // The real message that leaked: a Prisma error carrying a compiled file path.
    const raw = String.raw`Invalid prisma.discoveredPage.create() invocation in C:\Projects\QA PLATFORM\apps\backend\dist\discovery\crawler.js:85:69 - Unique constraint failed`;
    const text = describeDiscoveryFailure(raw);
    expect(text).not.toContain("C:\\");
    expect(text).not.toContain("prisma");
    expect(text).not.toContain("crawler.js");
    expect(text).toBe("Discovery could not be completed. The server log has the details.");
  });

  it("does not leak a stack trace or a connection string", () => {
    expect(describeDiscoveryFailure("postgresql://user:secret@host/db")).not.toContain("secret");
    expect(describeDiscoveryFailure("at Object.<anonymous> (/app/src/x.ts:1:1)")).not.toContain("/app/src");
  });
});
