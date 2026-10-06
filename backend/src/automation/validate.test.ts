import { describe, expect, it } from "vitest";
import { automationProgramSchema, type ManualActionReason } from "./program";
import { parseAndValidateProgram, validateProgram } from "./validate";

const gotoStep = { action: "goto", path: "/", description: "Open the application" } as const;
const assertStep = { action: "expectVisible", locator: { strategy: "role", value: "heading", name: "Fixture Home" }, description: "The heading is visible" } as const;

const program = (steps: unknown[]) => automationProgramSchema.parse({ name: "Example program", steps });

describe("automation program schema", () => {
  it("rejects an unknown action", () => {
    expect(() => program([{ action: "evaluate", script: "fetch('/')", description: "run script" }])).toThrow();
  });

  it("rejects a step with no description", () => {
    expect(() => program([{ action: "goto", path: "/" }])).toThrow();
  });

  it("accepts the supported action set", () => {
    expect(program([gotoStep, assertStep]).steps).toHaveLength(2);
  });
});

describe("automation policy validation", () => {
  it("passes a well-formed program that uses resilient locators", () => {
    const report = validateProgram(program([gotoStep, { action: "fill", locator: { strategy: "label", value: "Name" }, value: "Ada", description: "Enter a name" }, assertStep]));
    expect(report.status).toBe("PASSED");
    expect(report.issues).toHaveLength(0);
  });

  it("fails a program with no assertion, because it can never fail", () => {
    const report = validateProgram(program([gotoStep, { action: "click", locator: { strategy: "testId", value: "submit" }, description: "Submit" }]));
    expect(report.status).toBe("FAILED");
    expect(report.issues.map(issue => issue.code)).toContain("PROGRAM_HAS_NO_ASSERTION");
  });

  it("fails a program that does not start by navigating", () => {
    const report = validateProgram(program([assertStep]));
    expect(report.issues.map(issue => issue.code)).toContain("PROGRAM_MUST_START_WITH_GOTO");
  });

  it("blocks navigation to another host", () => {
    for (const path of ["https://evil.example/steal", "//evil.example/steal", "file:///etc/passwd"]) {
      const report = validateProgram(program([{ action: "goto", path, description: "Navigate away" }, assertStep]));
      expect(report.status).toBe("FAILED");
      expect(report.issues.some(issue => issue.code === "PATH_ABSOLUTE_URL" || issue.code === "PATH_PROTOCOL_RELATIVE")).toBe(true);
    }
  });

  it("blocks bare tag and wildcard CSS locators", () => {
    for (const value of ["div", "*", "body"]) {
      const report = validateProgram(program([gotoStep, { action: "expectVisible", locator: { strategy: "css", value }, description: "Check" }]));
      expect(report.issues.map(issue => issue.code)).toContain("LOCATOR_TOO_BROAD");
    }
  });

  it("blocks a javascript: locator", () => {
    const report = validateProgram(program([gotoStep, { action: "click", locator: { strategy: "css", value: "a[href^='javascript:void(0)']" }, description: "Click" }, assertStep]));
    expect(report.issues.map(issue => issue.code)).toContain("LOCATOR_FORBIDDEN_SCHEME");
  });

  it("blocks credential-shaped values from being stored in automation", () => {
    const secrets = ["sk-abcdefghijklmnopqrstuvwxyz012345", "Bearer abcdefghijklmnopqrstuvwxyz0123456789", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"];
    for (const value of secrets) {
      const report = validateProgram(program([gotoStep, { action: "fill", locator: { strategy: "testId", value: "token" }, value, description: "Enter token" }, assertStep]));
      expect(report.status).toBe("FAILED");
      expect(report.issues.some(issue => issue.code.startsWith("VALUE_LOOKS_LIKE_"))).toBe(true);
    }
  });

  it("warns but does not fail on a fragile locator strategy", () => {
    const report = validateProgram(program([gotoStep, { action: "expectVisible", locator: { strategy: "text", value: "Welcome" }, description: "Check greeting" }]));
    expect(report.status).toBe("PASSED_WITH_WARNINGS");
    expect(report.issues.every(issue => issue.severity === "WARNING")).toBe(true);
  });

  it("warns when a role locator has no accessible name", () => {
    const report = validateProgram(program([gotoStep, { action: "expectVisible", locator: { strategy: "role", value: "button" }, description: "Check button" }]));
    expect(report.issues.map(issue => issue.code)).toContain("LOCATOR_ROLE_WITHOUT_NAME");
  });

  it("reports schema failures through parseAndValidateProgram instead of throwing", () => {
    const result = parseAndValidateProgram({ name: "x", steps: [] });
    expect(result.program).toBeNull();
    expect(result.report.status).toBe("FAILED");
    expect(result.report.issues.every(issue => issue.code === "SCHEMA_INVALID")).toBe(true);
  });
});

describe("redundant assertions", () => {
  const assertion = (value: string) => ({ action: "expectText" as const, description: "check", locator: { strategy: "testId" as const, value }, value: "Sign in", match: "contains" as const });
  const base = { schemaVersion: "v1" as const, name: "Example program", steps: [{ action: "goto" as const, description: "open", path: "/" }] };

  it("rejects a program that asserts the same thing three times", () => {
    // Real output: a 3-step test case became a 20-step program, 18 near-duplicate assertions.
    const report = validateProgram({ ...base, steps: [...base.steps, assertion("signin"), assertion("signin"), assertion("signin")] });
    expect(report.status).toBe("FAILED");
    expect(report.issues.some(issue => issue.code === "PROGRAM_HAS_REDUNDANT_ASSERTIONS")).toBe(true);
  });

  it("allows the same assertion twice, which can be legitimate before and after an action", () => {
    const report = validateProgram({ ...base, steps: [...base.steps, assertion("signin"), assertion("signin")] });
    expect(report.issues.some(issue => issue.code === "PROGRAM_HAS_REDUNDANT_ASSERTIONS")).toBe(false);
  });

  it("does not flag a repeated action, only a repeated assertion", () => {
    // Clicking the same control repeatedly is normal - paging through a list, for example.
    const click = { action: "click" as const, description: "next", locator: { strategy: "testId" as const, value: "next" } };
    const report = validateProgram({ ...base, steps: [...base.steps, click, click, click, assertion("done")] });
    expect(report.issues.some(issue => issue.code === "PROGRAM_HAS_REDUNDANT_ASSERTIONS")).toBe(false);
  });
});

describe("pauseForUser policy", () => {
  const pause = (prompt: string, reason: ManualActionReason = "OTP") => ({ action: "pauseForUser" as const, reason, prompt, description: "Wait for the person" });

  it("accepts a pause that is followed by an assertion", () => {
    const report = validateProgram(program([gotoStep, pause("Complete the SMS verification in your own browser."), assertStep]));
    expect(report.status).toBe("PASSED");
  });

  it("rejects a pause with nothing after it, because nothing is verified", () => {
    const report = validateProgram(program([gotoStep, assertStep, pause("Complete the SMS verification in your own browser.")]));
    expect(report.status).toBe("FAILED");
    expect(report.issues.some(issue => issue.code === "PAUSE_HAS_NOTHING_AFTER_IT")).toBe(true);
  });

  it("rejects a program that needs a person more than twice", () => {
    const steps = [gotoStep, pause("Approve the request in your email client."), pause("Confirm the payment in your banking app."), pause("Solve the challenge shown on the page."), assertStep];
    const report = validateProgram(program(steps));
    expect(report.status).toBe("FAILED");
    expect(report.issues.some(issue => issue.code === "PROGRAM_HAS_TOO_MANY_PAUSES")).toBe(true);
  });

  it("allows two pauses, which a sign-in plus a payment legitimately needs", () => {
    const steps = [gotoStep, pause("Complete the SMS verification in your own browser."), pause("Confirm the payment in your banking app.", "PAYMENT_CONFIRMATION"), assertStep];
    expect(validateProgram(program(steps)).issues.some(issue => issue.code === "PROGRAM_HAS_TOO_MANY_PAUSES")).toBe(false);
  });

  it("rejects a prompt that asks the person to type the code into Testloop", () => {
    const report = validateProgram(program([gotoStep, pause("Enter the 6-digit code below and we will continue."), assertStep]));
    expect(report.status).toBe("FAILED");
    expect(report.issues.some(issue => issue.code === "PAUSE_PROMPT_SOLICITS_INPUT")).toBe(true);
  });

  it("rejects a prompt that asks the person to send the code to Testloop by name", () => {
    // The rule is about where a secret is directed, so it has to recognise the product's own
    // name - otherwise "send it to testloop" walks straight past the check meant to catch it.
    const report = validateProgram(program([gotoStep, pause("Check your phone and forward the code to Testloop."), assertStep]));
    expect(report.status).toBe("FAILED");
    expect(report.issues.some(issue => issue.code === "PAUSE_PROMPT_SOLICITS_SECRET")).toBe(true);
  });

  it("rejects a prompt that asks the person to send the code to us", () => {
    const report = validateProgram(program([gotoStep, pause("Check your phone and send the code to us."), assertStep]));
    expect(report.status).toBe("FAILED");
    expect(report.issues.some(issue => issue.code === "PAUSE_PROMPT_SOLICITS_SECRET")).toBe(true);
  });

  it("does not flag a prompt that tells the person to act in their own browser", () => {
    // The wording nearest the forbidden case: it names the code and the act of entering it, but
    // directs both at the target application rather than at us.
    const report = validateProgram(program([gotoStep, pause("Enter the code from your phone into the checkout page, then return here."), assertStep]));
    expect(report.issues.some(issue => issue.code.startsWith("PAUSE_PROMPT_SOLICITS"))).toBe(false);
  });

  it("rejects a prompt carrying a literal credential", () => {
    const report = validateProgram(program([gotoStep, pause("Use the token Bearer abcdefghijklmnopqrstuvwxyz012345 to continue."), assertStep]));
    expect(report.status).toBe("FAILED");
    expect(report.issues.some(issue => issue.code === "VALUE_LOOKS_LIKE_BEARER_TOKEN")).toBe(true);
  });

  it("gives the step no field that could carry what the person typed", () => {
    // The safety property is structural, not advisory: there is nowhere in a stored program to put
    // an OTP, so one cannot reach a version, an artifact, or a log.
    const parsed = program([gotoStep, pause("Complete the SMS verification in your own browser."), assertStep]);
    expect(Object.keys(parsed.steps[1])).not.toContain("value");
    expect(parsed.steps[1]).toEqual({ action: "pauseForUser", reason: "OTP", prompt: "Complete the SMS verification in your own browser.", description: "Wait for the person" });
  });
});
