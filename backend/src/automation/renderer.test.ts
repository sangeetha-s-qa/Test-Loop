import { describe, expect, it } from "vitest";
import { automationProgramSchema } from "./program";
import { renderPlaywrightSpec } from "./renderer";

describe("playwright spec renderer", () => {
  const program = automationProgramSchema.parse({
    name: "Contact form submits",
    steps: [
      { action: "goto", path: "/form", description: "Open the contact form" },
      { action: "fill", locator: { strategy: "label", value: "Name" }, value: "Ada", description: "Enter a name" },
      { action: "select", locator: { strategy: "testId", value: "kind" }, value: "Question", description: "Choose a kind" },
      { action: "check", locator: { strategy: "label", value: "Updates" }, checked: true, description: "Opt in" },
      { action: "click", locator: { strategy: "role", value: "button", name: "Send" }, description: "Submit" },
      { action: "expectText", locator: { strategy: "testId", value: "result" }, value: "Thanks", match: "contains", description: "Confirmation is shown" },
    ],
  });

  const source = renderPlaywrightSpec(program, "http://127.0.0.1:4317/");

  it("emits one statement per step", () => {
    expect(source.match(/^\s{2}await |^\s{2}expect\(/gm)?.length).toBe(program.steps.length);
  });

  it("uses the locator strategy that was chosen", () => {
    expect(source).toContain("page.getByLabel('Name')");
    expect(source).toContain("page.getByTestId('kind')");
    expect(source).toContain("page.getByRole('button', { name: 'Send' })");
  });

  it("resolves navigation against the base URL rather than embedding an absolute URL", () => {
    expect(source).toContain("new URL('/form', baseURL)");
  });

  it("escapes quotes so a crafted value cannot break out of the emitted string", () => {
    const crafted = automationProgramSchema.parse({
      name: "Crafted",
      steps: [
        { action: "goto", path: "/", description: "Open" },
        { action: "fill", locator: { strategy: "testId", value: "q" }, value: "'); process.exit(1); ('", description: "Enter" },
        { action: "expectVisible", locator: { strategy: "testId", value: "q" }, description: "Check" },
      ],
    });
    const rendered = renderPlaywrightSpec(crafted, "http://127.0.0.1:4317/");
    expect(rendered).toContain("\\'); process.exit(1); (\\'");
  });
});
