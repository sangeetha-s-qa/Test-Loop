import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, firefox, webkit } from "playwright";
import { createFixtureServer } from "./server";

describe("local discovery fixture", () => {
  const fixture = createFixtureServer(4318);
  beforeAll(() => fixture.start());
  afterAll(() => fixture.stop());

  it.each([["chromium", chromium], ["firefox", firefox], ["webkit", webkit]] as const)("serves the fixture in %s", async (_name, browserType) => {
    const browser = await browserType.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${fixture.url.replace("4317", "4318")}form`);
    expect(await page.title()).toBe("Form Fixture");
    expect(await page.locator("a[href]").count()).toBeGreaterThan(0);
    expect(await page.locator("select").count()).toBe(1);
    expect(await page.locator("input[type=checkbox]").count()).toBe(1);
    expect(await page.locator("button").count()).toBe(1);
    expect(await page.locator('label[for="name"]').textContent()).toContain("Name");
    await browser.close();
    // No per-test timeout override: the suite-wide 20s applies, which is ample now that browser
    // test files no longer run concurrently.
  });
});
