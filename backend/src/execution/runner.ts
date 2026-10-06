import type { FailureCategory } from "@prisma/client";
import type { Locator, Page } from "playwright";
import { expect } from "playwright/test";
import type { AutomationLocator, AutomationStep, ManualActionReason } from "../automation/program";

/**
 * Interprets one validated automation step against a real Playwright page.
 *
 * There is no code evaluation anywhere in this file: every step is a typed value from the
 * program schema, and this switch is the only thing that can drive the browser. That is what
 * makes the Phase 5/6 gate ("generated automation cannot access host resources") hold.
 */

export class StepFailure extends Error {
  constructor(
    public readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

export function resolveLocator(page: Page, locator: AutomationLocator): Locator {
  const options = locator.exact === undefined ? undefined : { exact: locator.exact };
  const base = (() => {
    switch (locator.strategy) {
      case "testId": return page.getByTestId(locator.value);
      case "role": return page.getByRole(locator.value as Parameters<Page["getByRole"]>[0], locator.name ? { name: locator.name, ...(locator.exact === undefined ? {} : { exact: locator.exact }) } : undefined);
      case "label": return page.getByLabel(locator.value, options);
      case "placeholder": return page.getByPlaceholder(locator.value, options);
      case "text": return page.getByText(locator.value, options);
      case "altText": return page.getByAltText(locator.value, options);
      case "title": return page.getByTitle(locator.value, options);
      case "css": return page.locator(locator.value);
    }
  })();
  return locator.nth === undefined ? base : base.nth(locator.nth);
}

/** Turns a Playwright error into a category the platform can act on. */
export function classifyError(error: unknown): { category: FailureCategory; message: string } {
  if (error instanceof StepFailure) return { category: error.category, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  // Infrastructure is checked first on purpose. A browser that died mid-assertion produces a
  // message containing both, and reporting that as ASSERTION_FAILED would invent a product bug.
  if (/Target (page|browser|context).*(has been closed|closed|crashed)|Browser has been closed|browserType\.launch|Protocol error|Execution context was destroyed/i.test(message)) return { category: "INFRASTRUCTURE", message };
  if (/strict mode violation|resolved to \d+ elements/i.test(message)) return { category: "LOCATOR_AMBIGUOUS", message };
  if (/net::ERR|NS_ERROR|Navigation failed|ERR_CONNECTION|navigating to ".*", waiting/i.test(message)) return { category: "NAVIGATION_FAILED", message };
  if (/Timeout .* exceeded|waiting for locator|exceeded while waiting/i.test(message)) return { category: "LOCATOR_NOT_FOUND", message };
  if (/expect\(|toBeVisible|toHaveText|toHaveValue|toHaveCount|toHaveURL|toHaveTitle|toBeHidden/i.test(message)) return { category: "ASSERTION_FAILED", message };
  return { category: "UNKNOWN", message };
}

export type StepContext = {
  page: Page;
  /** The approved origin. Every `goto` is resolved against it, so navigation cannot leave it. */
  baseUrl: string;
  timeoutMs: number;
  /** Called for a `screenshot` step; returns nothing so a capture failure never fails the test. */
  captureScreenshot: (name: string) => Promise<void>;
  /**
   * Called for a `pauseForUser` step. Resolves once a person has confirmed they acted, and rejects
   * if the wait expired or was aborted.
   *
   * Optional because suspending a run needs a broker that outlives this function — a durable row to
   * poll and an API for the person to answer on. Until a caller supplies one, the step below fails
   * closed rather than being skipped: a test that quietly walked past its OTP would report a pass
   * for a flow nobody completed.
   */
  requestManualAction?: (request: { reason: ManualActionReason; prompt: string }) => Promise<void>;
};

export async function executeStep(step: AutomationStep, context: StepContext): Promise<void> {
  const { page, timeoutMs } = context;
  const at = (locator: AutomationLocator) => resolveLocator(page, locator);

  switch (step.action) {
    case "goto": {
      const target = new URL(step.path, context.baseUrl);
      // The program validator already rejected absolute paths; this re-check makes the runner
      // safe on its own, including for versions approved before a validator change.
      if (target.origin !== new URL(context.baseUrl).origin) throw new StepFailure("POLICY_VIOLATION", "Navigation left the approved application origin");
      const response = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (response && response.status() >= 500) throw new StepFailure("NAVIGATION_FAILED", `Navigation returned HTTP ${response.status()}`);
      return;
    }
    case "click": return at(step.locator).click({ timeout: timeoutMs });
    case "fill": return at(step.locator).fill(step.value, { timeout: timeoutMs });
    case "select": { await at(step.locator).selectOption(step.value, { timeout: timeoutMs }); return; }
    case "check": return step.checked ? at(step.locator).check({ timeout: timeoutMs }) : at(step.locator).uncheck({ timeout: timeoutMs });
    case "press": return step.locator ? at(step.locator).press(step.key, { timeout: timeoutMs }) : page.keyboard.press(step.key);
    case "hover": return at(step.locator).hover({ timeout: timeoutMs });
    case "waitForVisible": return at(step.locator).waitFor({ state: "visible", timeout: step.timeoutMs ?? timeoutMs });
    case "waitForUrl": { await page.waitForURL(url => url.toString().includes(step.pattern), { timeout: step.timeoutMs ?? timeoutMs }); return; }
    case "screenshot": return context.captureScreenshot(step.name);
    case "pauseForUser": {
      if (!context.requestManualAction) {
        throw new StepFailure("POLICY_VIOLATION", `This test needs a person (${step.reason}) but the run was started without support for pausing.`);
      }
      return context.requestManualAction({ reason: step.reason, prompt: step.prompt });
    }
    case "expectVisible": return expect(at(step.locator)).toBeVisible({ timeout: timeoutMs });
    case "expectHidden": return expect(at(step.locator)).toBeHidden({ timeout: timeoutMs });
    case "expectText": return step.match === "equals" ? expect(at(step.locator)).toHaveText(step.value, { timeout: timeoutMs }) : expect(at(step.locator)).toContainText(step.value, { timeout: timeoutMs });
    case "expectValue": return expect(at(step.locator)).toHaveValue(step.value, { timeout: timeoutMs });
    case "expectUrl": {
      const current = page.url();
      const matches = step.match === "equals" ? current === new URL(step.pattern, context.baseUrl).toString() : current.includes(step.pattern);
      if (!matches) throw new StepFailure("ASSERTION_FAILED", `Expected the URL to ${step.match} "${step.pattern}" but it was "${current}"`);
      return;
    }
    case "expectTitle": {
      const title = await page.title();
      const matches = step.match === "equals" ? title === step.value : title.includes(step.value);
      if (!matches) throw new StepFailure("ASSERTION_FAILED", `Expected the title to ${step.match} "${step.value}" but it was "${title}"`);
      return;
    }
    case "expectCount": return expect(at(step.locator)).toHaveCount(step.count, { timeout: timeoutMs });
  }
}

/**
 * Captures the DOM neighbourhood of a failed locator. This is the evidence a healing proposal
 * needs, and it is only collected on failure so a passing run stays cheap.
 */
export async function captureLocatorEvidence(page: Page, locator: AutomationLocator | null): Promise<Record<string, unknown>> {
  const evidence: Record<string, unknown> = { url: page.url(), title: await page.title().catch(() => null) };
  if (!locator) return evidence;
  try {
    evidence.matchCount = await resolveLocator(page, locator).count();
  } catch {
    evidence.matchCount = null;
  }
  try {
    // A bounded, attribute-level snapshot of interactive elements. Text is truncated so page
    // content can never blow up the row or the later AI prompt.
    evidence.candidates = await page.locator("a, button, input, select, textarea, [role], [data-testid]").evaluateAll(nodes =>
      nodes.slice(0, 120).map(node => ({
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role"),
        testId: node.getAttribute("data-testid"),
        id: node.id || null,
        name: node.getAttribute("name"),
        type: node.getAttribute("type"),
        placeholder: node.getAttribute("placeholder"),
        ariaLabel: node.getAttribute("aria-label"),
        text: (node.textContent ?? "").trim().slice(0, 120) || null,
        visible: !!(node as HTMLElement).offsetParent || getComputedStyle(node).position === "fixed",
      })),
    );
  } catch {
    evidence.candidates = [];
  }
  return evidence;
}
