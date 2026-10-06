import type { AutomationLocator, AutomationProgram, AutomationStep } from "./program";

/**
 * Renders a program as a readable Playwright spec for human review and export.
 *
 * This output is documentation, not an execution path: the runner interprets the program
 * directly (see `execution/runner.ts`) and never evaluates this string. Keeping the two in sync
 * is the renderer's only job, so every step maps to exactly one emitted line.
 */

const quote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

function renderLocator(locator: AutomationLocator): string {
  const exact = locator.exact ? ", { exact: true }" : "";
  const base = (() => {
    switch (locator.strategy) {
      case "testId": return `page.getByTestId(${quote(locator.value)})`;
      case "role": return `page.getByRole(${quote(locator.value)}${locator.name ? `, { name: ${quote(locator.name)}${locator.exact ? ", exact: true" : ""} }` : ""})`;
      case "label": return `page.getByLabel(${quote(locator.value)}${exact})`;
      case "placeholder": return `page.getByPlaceholder(${quote(locator.value)}${exact})`;
      case "text": return `page.getByText(${quote(locator.value)}${exact})`;
      case "altText": return `page.getByAltText(${quote(locator.value)}${exact})`;
      case "title": return `page.getByTitle(${quote(locator.value)}${exact})`;
      case "css": return `page.locator(${quote(locator.value)})`;
    }
  })();
  return locator.nth === undefined ? base : `${base}.nth(${locator.nth})`;
}

function renderStep(step: AutomationStep): string {
  switch (step.action) {
    case "goto": return `await page.goto(new URL(${quote(step.path)}, baseURL).toString());`;
    case "click": return `await ${renderLocator(step.locator)}.click();`;
    case "fill": return `await ${renderLocator(step.locator)}.fill(${quote(step.value)});`;
    case "select": return `await ${renderLocator(step.locator)}.selectOption(${quote(step.value)});`;
    case "check": return `await ${renderLocator(step.locator)}.${step.checked ? "check" : "uncheck"}();`;
    case "press": return step.locator ? `await ${renderLocator(step.locator)}.press(${quote(step.key)});` : `await page.keyboard.press(${quote(step.key)});`;
    case "hover": return `await ${renderLocator(step.locator)}.hover();`;
    case "waitForVisible": return `await ${renderLocator(step.locator)}.waitFor({ state: 'visible'${step.timeoutMs ? `, timeout: ${step.timeoutMs}` : ""} });`;
    case "waitForUrl": return `await page.waitForURL(${quote(`**${step.pattern}**`)}${step.timeoutMs ? `, { timeout: ${step.timeoutMs} }` : ""});`;
    case "screenshot": return `await page.screenshot({ path: ${quote(`${step.name}.png`)}, fullPage: true });`;
    // Rendered as a no-op `test.step` on purpose. Testloop suspends the real run here and waits for
    // a person; a plain Playwright spec has nobody to wait for, so an exported copy must read as a
    // clearly-labelled gap rather than a call to a helper that does not exist.
    case "pauseForUser": return `await test.step(${quote(`MANUAL (${step.reason}): ${step.prompt}`)}, async () => { /* Testloop pauses here for a person. */ });`;
    case "expectVisible": return `await expect(${renderLocator(step.locator)}).toBeVisible();`;
    case "expectHidden": return `await expect(${renderLocator(step.locator)}).toBeHidden();`;
    case "expectText": return step.match === "equals" ? `await expect(${renderLocator(step.locator)}).toHaveText(${quote(step.value)});` : `await expect(${renderLocator(step.locator)}).toContainText(${quote(step.value)});`;
    case "expectValue": return `await expect(${renderLocator(step.locator)}).toHaveValue(${quote(step.value)});`;
    case "expectUrl": return step.match === "equals" ? `await expect(page).toHaveURL(${quote(step.pattern)});` : `expect(page.url()).toContain(${quote(step.pattern)});`;
    case "expectTitle": return step.match === "equals" ? `await expect(page).toHaveTitle(${quote(step.value)});` : `expect(await page.title()).toContain(${quote(step.value)});`;
    case "expectCount": return `await expect(${renderLocator(step.locator)}).toHaveCount(${step.count});`;
  }
}

export function renderPlaywrightSpec(program: AutomationProgram, applicationUrl: string): string {
  const body = program.steps
    .map(step => `  // ${step.description.replace(/\r?\n/g, " ")}\n  ${renderStep(step)}`)
    .join("\n\n");
  return [
    "import { expect, test } from '@playwright/test';",
    "",
    `const baseURL = ${quote(applicationUrl)};`,
    "",
    `test(${quote(program.name)}, async ({ page }) => {`,
    body,
    "});",
    "",
  ].join("\n");
}
