import { config } from "../config";
import { assertionActions, automationProgramSchema, type AutomationLocator, type AutomationProgram } from "./program";

export type ValidationIssue = { severity: "ERROR" | "WARNING"; code: string; message: string; stepIndex: number | null };
export type ValidationReport = { status: "PASSED" | "PASSED_WITH_WARNINGS" | "FAILED"; issues: ValidationIssue[] };

/**
 * Locator strategies that survive markup changes best. The generator is told to prefer them and
 * anything weaker is flagged so a reviewer sees the risk before approving a version.
 */
const preferredStrategies = new Set(["testId", "role", "label", "placeholder"]);

/**
 * CSS selectors that reach outside the page or match too broadly. `css` is allowed because real
 * applications need it, but it must identify one element and must not be a bare tag selector.
 */
const forbiddenCssPatterns: { pattern: RegExp; code: string; message: string }[] = [
  { pattern: /^\s*(html|body|div|span|a|p|input|button|form|\*)\s*$/i, code: "LOCATOR_TOO_BROAD", message: "A bare tag or wildcard CSS selector matches too many elements." },
  { pattern: /javascript:/i, code: "LOCATOR_FORBIDDEN_SCHEME", message: "Locator contains a javascript: scheme." },
  { pattern: /^\s*iframe/i, code: "LOCATOR_FRAME_UNSUPPORTED", message: "Frame traversal is not supported by the runner." },
];

/** Paths that would take execution off the approved origin or onto a local resource. */
const forbiddenPathPatterns: { pattern: RegExp; code: string; message: string }[] = [
  { pattern: /^[a-z][a-z0-9+.-]*:/i, code: "PATH_ABSOLUTE_URL", message: "Navigation must use a path relative to the approved application URL, not an absolute URL." },
  { pattern: /^\/\//, code: "PATH_PROTOCOL_RELATIVE", message: "Protocol-relative navigation targets another host and is not allowed." },
];

/**
 * A test that needs a person three separate times is not an automated test, and a model with an
 * array to fill will reach for a pause the moment a step looks hard. Two is enough for the real
 * cases (sign in behind an OTP, then confirm a payment) and low enough that padding is rejected.
 */
const MAX_PAUSES_PER_PROGRAM = 2;

/**
 * A pause prompt must tell the person to act in their *own* browser. A prompt that asks them to
 * hand the code back to us would turn the one step that is designed to never touch a secret into
 * the one step that collects them, so this is an error rather than a warning.
 */
const promptSolicitsSecretPatterns: { pattern: RegExp; code: string; message: string }[] = [
  {
    pattern: /\b(enter|type|paste|provide|input)\b[^.]{0,40}\b(here|below|in (?:this|the) (?:field|box|form|input))\b/i,
    code: "PAUSE_PROMPT_SOLICITS_INPUT",
    message: "A pause prompt must not ask the person to enter anything into Testloop. Tell them to complete the action in their own browser.",
  },
  {
    pattern: /\b(tell|give|send|share|forward)\b[^.]{0,30}\b(us|testloop|the (?:platform|system|agent))\b/i,
    code: "PAUSE_PROMPT_SOLICITS_SECRET",
    message: "A pause prompt must not ask the person to pass a code or credential to Testloop.",
  },
];

/** Values that look like real credentials or secrets must never be baked into a stored version. */
const secretLikePatterns: { pattern: RegExp; code: string }[] = [
  { pattern: /\b(sk|pk)-[A-Za-z0-9]{16,}\b/, code: "VALUE_LOOKS_LIKE_API_KEY" },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i, code: "VALUE_LOOKS_LIKE_BEARER_TOKEN" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, code: "VALUE_LOOKS_LIKE_JWT" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, code: "VALUE_LOOKS_LIKE_PRIVATE_KEY" },
];

function validateLocator(locator: AutomationLocator, stepIndex: number, issues: ValidationIssue[]) {
  if (locator.strategy === "role" && !locator.name) {
    issues.push({ severity: "WARNING", code: "LOCATOR_ROLE_WITHOUT_NAME", message: "A role locator without an accessible name can match multiple elements.", stepIndex });
  }
  if (locator.strategy === "css") {
    for (const { pattern, code, message } of forbiddenCssPatterns) {
      if (pattern.test(locator.value)) issues.push({ severity: "ERROR", code, message, stepIndex });
    }
  }
  if (!preferredStrategies.has(locator.strategy)) {
    issues.push({ severity: "WARNING", code: "LOCATOR_FRAGILE_STRATEGY", message: `Strategy "${locator.strategy}" is less resilient than a test id, role, or label locator.`, stepIndex });
  }
}

function validateValue(value: string, stepIndex: number, issues: ValidationIssue[]) {
  for (const { pattern, code } of secretLikePatterns) {
    if (pattern.test(value)) issues.push({ severity: "ERROR", code, message: "The step value looks like a real credential. Automation must not embed secrets.", stepIndex });
  }
}

/**
 * Static policy check applied before an automation version is stored and again before it executes.
 * Returns every issue found rather than throwing on the first, so a reviewer sees the whole picture.
 */
export function validateProgram(program: AutomationProgram): ValidationReport {
  const issues: ValidationIssue[] = [];

  if (program.steps.length > config.AUTOMATION_MAX_STEPS) {
    issues.push({ severity: "ERROR", code: "PROGRAM_TOO_LONG", message: `The program has ${program.steps.length} steps but the configured maximum is ${config.AUTOMATION_MAX_STEPS}.`, stepIndex: null });
  }
  if (!program.steps.some(step => assertionActions.includes(step.action))) {
    issues.push({ severity: "ERROR", code: "PROGRAM_HAS_NO_ASSERTION", message: "A test that asserts nothing can never fail. Add at least one expect step.", stepIndex: null });
  }
  if (program.steps[0]?.action !== "goto") {
    issues.push({ severity: "ERROR", code: "PROGRAM_MUST_START_WITH_GOTO", message: "The first step must navigate to a page.", stepIndex: 0 });
  }

  const pauseIndexes = program.steps.flatMap((step, stepIndex) => (step.action === "pauseForUser" ? [stepIndex] : []));
  if (pauseIndexes.length > MAX_PAUSES_PER_PROGRAM) {
    issues.push({
      severity: "ERROR",
      code: "PROGRAM_HAS_TOO_MANY_PAUSES",
      message: `The program asks for a person ${pauseIndexes.length} times but the maximum is ${MAX_PAUSES_PER_PROGRAM}. Split it into separate test cases.`,
      stepIndex: null,
    });
  }
  // Every pause holds a browser and a human. One that has nothing after it has bought neither an
  // action nor an assertion, so it is dead weight on both - and the grammar cannot express
  // "not last", which is why it is caught here and fed back through the repair loop.
  const lastPause = pauseIndexes.at(-1);
  if (lastPause !== undefined && lastPause === program.steps.length - 1) {
    issues.push({
      severity: "ERROR",
      code: "PAUSE_HAS_NOTHING_AFTER_IT",
      message: "A pause is the last step, so nothing is checked once the person has acted. Assert the result of the action they took.",
      stepIndex: lastPause,
    });
  }

  // A model with an array ceiling and nothing to say will pad to it. A real run produced a 20-step
  // program from a 3-step test case, 18 of them near-duplicate assertions - asserting the same text
  // five times. Repeating an *action* can be legitimate (clicking through pagination); repeating an
  // assertion verifies nothing new, so only assertions are counted here.
  const assertionSignatures = new Map<string, number>();
  for (const step of program.steps) {
    if (!assertionActions.includes(step.action)) continue;
    const locator = "locator" in step && step.locator ? `${step.locator.strategy}:${step.locator.value}` : "";
    const value = "value" in step && typeof step.value === "string" ? step.value : "";
    const signature = `${step.action}|${locator}|${value}`;
    assertionSignatures.set(signature, (assertionSignatures.get(signature) ?? 0) + 1);
  }
  for (const [signature, count] of assertionSignatures) {
    if (count < 3) continue;
    issues.push({ severity: "ERROR", code: "PROGRAM_HAS_REDUNDANT_ASSERTIONS", message: `The same assertion appears ${count} times (${signature.split("|")[0]}). Repeating an assertion verifies nothing new - assert each thing once.`, stepIndex: null });
  }

  const screenshotNames = new Set<string>();
  program.steps.forEach((step, stepIndex) => {
    if ("locator" in step && step.locator) validateLocator(step.locator, stepIndex, issues);
    if ("value" in step && typeof step.value === "string") validateValue(step.value, stepIndex, issues);

    if (step.action === "goto") {
      for (const { pattern, code, message } of forbiddenPathPatterns) {
        if (pattern.test(step.path)) issues.push({ severity: "ERROR", code, message, stepIndex });
      }
    }
    if (step.action === "pauseForUser") {
      // The prompt is model-written text shown to a person, so it is checked both for a literal
      // secret and for asking the person to hand one over.
      validateValue(step.prompt, stepIndex, issues);
      for (const { pattern, code, message } of promptSolicitsSecretPatterns) {
        if (pattern.test(step.prompt)) issues.push({ severity: "ERROR", code, message, stepIndex });
      }
    }
    if (step.action === "screenshot") {
      if (screenshotNames.has(step.name)) issues.push({ severity: "WARNING", code: "SCREENSHOT_NAME_REUSED", message: `Screenshot name "${step.name}" is used more than once; the later capture overwrites the earlier one.`, stepIndex });
      screenshotNames.add(step.name);
    }
  });

  const hasError = issues.some(issue => issue.severity === "ERROR");
  return { status: hasError ? "FAILED" : issues.length ? "PASSED_WITH_WARNINGS" : "PASSED", issues };
}

/** Parses untrusted JSON into a program and policy-validates it in one step. */
export function parseAndValidateProgram(input: unknown): { program: AutomationProgram; report: ValidationReport } | { program: null; report: ValidationReport } {
  const parsed = automationProgramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      program: null,
      report: { status: "FAILED", issues: parsed.error.issues.slice(0, 25).map(issue => ({ severity: "ERROR" as const, code: "SCHEMA_INVALID", message: `${issue.path.join(".") || "(root)"}: ${issue.message}`, stepIndex: typeof issue.path[1] === "number" ? issue.path[1] : null })) },
    };
  }
  return { program: parsed.data, report: validateProgram(parsed.data) };
}
