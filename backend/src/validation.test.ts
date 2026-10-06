import { describe, expect, it } from "vitest";
import { projectSchema, testRunSchema } from "./validation";

describe("project validation", () => {
  it("accepts an HTTPS application URL", () => {
    expect(projectSchema.parse({ name: "Demo", applicationUrl: "https://example.com" }).applicationUrl).toBe("https://example.com");
  });

  it("rejects unsupported protocols", () => {
    expect(() => projectSchema.parse({ name: "Demo", applicationUrl: "ftp://example.com" })).toThrow();
  });

  it("requires authorization and at least one testing type", () => {
    const validSettings = { browser: "chromium", viewport: "desktop", maxPages: 50, maxTestCases: 100, timeoutSeconds: 30, retryCount: 1, captureScreenshots: true, recordVideo: false, captureTrace: true, consoleLogging: true, networkLogging: true, visualThreshold: 0.1 };
    expect(() => testRunSchema.parse({ projectId: "00000000-0000-0000-0000-000000000000", applicationUrl: "https://example.com", testingTypes: [], advancedSettings: validSettings, authorizationConfirmed: false })).toThrow();
  });

  it("requires custom dimensions for a custom viewport", () => {
    const settings = { browser: "chromium", viewport: "custom", maxPages: 50, maxTestCases: 100, timeoutSeconds: 30, retryCount: 1, captureScreenshots: true, recordVideo: false, captureTrace: true, consoleLogging: true, networkLogging: true, visualThreshold: 0.1 };
    expect(() => testRunSchema.parse({ projectId: "00000000-0000-0000-0000-000000000000", applicationUrl: "https://example.com", testingTypes: ["Navigation"], advancedSettings: settings, authorizationConfirmed: true })).toThrow();
  });
});
