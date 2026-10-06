import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { automationProgramSchema, type AutomationStep } from "../automation/program";
import { createFixtureServer } from "../fixture/server";
import { captureLocatorEvidence, classifyError, executeStep, StepFailure } from "./runner";

/**
 * Drives the real step interpreter against a real Chromium instance and the local fixture.
 * These assertions are the reason the platform can claim a PASSED result means something.
 */
describe("execution step runner", () => {
  const fixture = createFixtureServer(4319);
  const baseUrl = "http://127.0.0.1:4319/";
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    await fixture.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.setDefaultTimeout(4000);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fixture.stop();
  });

  const run = (step: unknown) => {
    const program = automationProgramSchema.parse({ name: "runner probe", steps: [step] });
    return executeStep(program.steps[0] as AutomationStep, { page, baseUrl, timeoutMs: 4000, captureScreenshot: async () => undefined });
  };

  it("navigates and asserts the page title", async () => {
    await run({ action: "goto", path: "/", description: "Open home" });
    await run({ action: "expectTitle", value: "Fixture Home", match: "equals", description: "Title matches" });
    expect(page.url()).toBe(baseUrl);
  });

  it("refuses to navigate off the approved origin", async () => {
    await expect(run({ action: "goto", path: "/", description: "Open home" }).then(() => executeStep(automationProgramSchema.parse({ name: "off-origin probe", steps: [{ action: "goto", path: "http://127.0.0.1:9/", description: "Leave" }] }).steps[0], { page, baseUrl, timeoutMs: 4000, captureScreenshot: async () => undefined }))).rejects.toThrow("Navigation left the approved application origin");
  });

  it("fills, selects, checks, and submits a real form", async () => {
    await run({ action: "goto", path: "/form", description: "Open the form" });
    await run({ action: "fill", locator: { strategy: "label", value: "Name" }, value: "Ada", description: "Enter a name" });
    await run({ action: "expectValue", locator: { strategy: "label", value: "Name" }, value: "Ada", description: "Value stored" });
    await run({ action: "select", locator: { strategy: "css", value: "#kind" }, value: "Feedback", description: "Choose a kind" });
    await run({ action: "check", locator: { strategy: "label", value: "Updates" }, checked: true, description: "Opt in" });
    await run({ action: "click", locator: { strategy: "role", value: "button", name: "Send" }, description: "Submit" });
    await run({ action: "expectText", locator: { strategy: "testId", value: "result" }, value: "we received your message", match: "contains", description: "Confirmation shown" });
  }, 30_000);

  it("signs in with the fixture credentials and reaches the dashboard", async () => {
    await run({ action: "goto", path: "/login", description: "Open sign in" });
    await run({ action: "fill", locator: { strategy: "testId", value: "username" }, value: fixture.credentials.username, description: "Enter username" });
    await run({ action: "fill", locator: { strategy: "testId", value: "password" }, value: fixture.credentials.password, description: "Enter password" });
    await run({ action: "click", locator: { strategy: "testId", value: "signin" }, description: "Submit" });
    await run({ action: "expectText", locator: { strategy: "testId", value: "welcome" }, value: "Welcome back", match: "contains", description: "Signed in" });
  }, 30_000);

  it("reports a failed assertion rather than passing", async () => {
    await run({ action: "goto", path: "/", description: "Open home" });
    await expect(run({ action: "expectTitle", value: "Some Other Title", match: "equals", description: "Wrong title" })).rejects.toThrow(StepFailure);
  });

  it("reports a missing locator as LOCATOR_NOT_FOUND", async () => {
    await run({ action: "goto", path: "/", description: "Open home" });
    const error = await run({ action: "click", locator: { strategy: "testId", value: "does-not-exist" }, description: "Click a missing element" }).catch(caught => caught);
    expect(classifyError(error).category).toBe("LOCATOR_NOT_FOUND");
  }, 30_000);

  it("reports an ambiguous locator instead of silently using the first match", async () => {
    await run({ action: "goto", path: "/", description: "Open home" });
    const error = await run({ action: "click", locator: { strategy: "css", value: "nav a" }, description: "Click a link" }).catch(caught => caught);
    expect(classifyError(error).category).toBe("LOCATOR_AMBIGUOUS");
  }, 30_000);

  it("collects DOM evidence for a failed locator", async () => {
    await run({ action: "goto", path: "/form", description: "Open the form" });
    const evidence = (await captureLocatorEvidence(page, { strategy: "testId", value: "missing" })) as { url: string; matchCount: number; candidates: { tag: string }[] };
    expect(evidence.url).toContain("/form");
    expect(evidence.matchCount).toBe(0);
    expect(evidence.candidates.some(candidate => candidate.tag === "input")).toBe(true);
  }, 30_000);

  const pauseStep = { action: "pauseForUser", reason: "OTP", prompt: "Complete the SMS verification in your own browser.", description: "Wait for the person" };

  it("fails closed when a test needs a person and the run cannot pause", () => {
    // The dangerous alternative is skipping the step: the run would sail past an unverified OTP
    // and report a pass for a flow nobody completed. POLICY_VIOLATION is not retried, so this
    // surfaces to the user instead of being quietly re-attempted.
    return expect(run(pauseStep)).rejects.toMatchObject({ category: "POLICY_VIOLATION" });
  });

  it("hands the reason and prompt to the broker when one is supplied", async () => {
    const seen: { reason: string; prompt: string }[] = [];
    const program = automationProgramSchema.parse({ name: "pause probe", steps: [pauseStep] });
    await executeStep(program.steps[0] as AutomationStep, {
      page,
      baseUrl,
      timeoutMs: 4000,
      captureScreenshot: async () => undefined,
      requestManualAction: async request => void seen.push(request),
    });
    expect(seen).toEqual([{ reason: "OTP", prompt: "Complete the SMS verification in your own browser." }]);
  });

  it("propagates a broker rejection so an expired wait fails the test rather than passing it", () => {
    const program = automationProgramSchema.parse({ name: "pause probe", steps: [pauseStep] });
    const promise = executeStep(program.steps[0] as AutomationStep, {
      page,
      baseUrl,
      timeoutMs: 4000,
      captureScreenshot: async () => undefined,
      requestManualAction: async () => {
        throw new StepFailure("TIMEOUT", "Nobody completed the manual action before the deadline");
      },
    });
    return expect(promise).rejects.toMatchObject({ category: "TIMEOUT" });
  });
});

describe("failure classification", () => {
  it("keeps an explicit StepFailure category", () => {
    expect(classifyError(new StepFailure("POLICY_VIOLATION", "blocked")).category).toBe("POLICY_VIOLATION");
  });

  it("classifies a browser crash as infrastructure, which is the only retryable category", () => {
    expect(classifyError(new Error("Target page, context or browser has been closed")).category).toBe("INFRASTRUCTURE");
  });

  it("classifies a navigation error", () => {
    expect(classifyError(new Error("page.goto: net::ERR_CONNECTION_REFUSED")).category).toBe("NAVIGATION_FAILED");
  });
});
