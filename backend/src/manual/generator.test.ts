import { describe, expect, it } from "vitest";
import { manualTestingTypes } from "./catalog";
import { generateManualCases, type GeneratorInput } from "./generator";

const discovery: GeneratorInput["discovery"] = {
  pages: [
    { id: "p-home", normalizedUrl: "https://shop.example.com/", title: "Shop Home", depth: 0 },
    { id: "p-login", normalizedUrl: "https://shop.example.com/login", title: "Sign in", depth: 1 },
    { id: "p-contact", normalizedUrl: "https://shop.example.com/contact", title: "Contact", depth: 1 },
    { id: "p-cart", normalizedUrl: "https://shop.example.com/cart", title: "Your cart", depth: 1 },
  ],
  forms: [
    { pageId: "p-login", identifier: "login-form", method: "post", fields: [{ name: "username", type: "text", label: "Username", required: true }, { name: "password", type: "password", label: "Password", required: true }] },
    { pageId: "p-contact", identifier: "contact-form", method: "post", fields: [{ name: "name", type: "text", label: "Name", required: true }, { name: "email", type: "email", label: null, required: true }, { name: "message", type: "textarea", label: "Message", required: false }] },
  ],
  links: [
    { pageId: "p-home", normalizedUrl: "https://shop.example.com/cart", visibleText: "Cart", sameOrigin: true },
    { pageId: "p-home", normalizedUrl: "https://shop.example.com/contact", visibleText: "Contact us", sameOrigin: true },
    { pageId: "p-home", normalizedUrl: "https://other.example.org/", visibleText: "Partner", sameOrigin: false },
  ],
  endpoints: [{ method: "GET", normalizedUrl: "https://shop.example.com/api/products", observedStatus: 200 }],
};

const input = (overrides: Partial<GeneratorInput> = {}): GeneratorInput => ({ applicationUrl: "https://shop.example.com/", applicationType: "ECOMMERCE", testingTypes: ["Functional"], requirements: "", browser: "chromium", discovery, ...overrides });

describe("manual test-case generator", () => {
  it("derives authentication cases from a discovered password form, including negatives", () => {
    const titles = generateManualCases(input(), 200).map(item => item.title);
    expect(titles).toContain("Sign in with valid credentials");
    expect(titles).toContain("Sign in with an invalid password is rejected");
    expect(titles).toContain("Sign in with empty fields shows validation");
  });

  it("derives validation, boundary, and format cases from discovered form fields", () => {
    const titles = generateManualCases(input(), 200).map(item => item.title);
    expect(titles.some(title => title.includes("Name is required"))).toBe(true);
    expect(titles.some(title => title.includes("invalid email format"))).toBe(true);
    expect(titles.some(title => title.includes("maximum-length"))).toBe(true);
  });

  it("only follows same-origin links for navigation cases", () => {
    const titles = generateManualCases(input({ testingTypes: ["Flow"] }), 200).map(item => item.title);
    expect(titles).toContain('"Cart" link opens the right page');
    expect(titles.some(title => title.includes("Partner"))).toBe(false);
  });

  it("never puts a real secret in test data", () => {
    for (const item of generateManualCases(input({ testingTypes: [...manualTestingTypes] }), 500)) {
      for (const [key, value] of Object.entries(item.testData)) if (/password/i.test(key)) expect(value).toMatch(/^</);
    }
  });

  it("marks domain flows as unverified when discovery saw no evidence of them", () => {
    const blog = { ...discovery!, pages: [{ id: "p", normalizedUrl: "https://blog.example.com/", title: "Thoughts", depth: 0 }], links: [], forms: [] };
    const [flow] = generateManualCases(input({ testingTypes: ["End-to-End"], discovery: blog }), 200);
    expect(flow.preconditions).toMatch(/^Requires verification/);
    const [observed] = generateManualCases(input({ testingTypes: ["End-to-End"] }), 200);
    expect(observed.preconditions).not.toMatch(/^Requires verification/);
  });

  it("produces cases for every manual testing type without discovery data", () => {
    const cases = generateManualCases(input({ discovery: null, testingTypes: [...manualTestingTypes] }), 500);
    const categories = new Set(cases.map(item => item.category));
    for (const type of manualTestingTypes) if (type !== "Other") expect(categories, type).toContain(type);
  });

  it("turns each requirement into a traceable case", () => {
    const cases = generateManualCases(input({ testingTypes: ["Smoke"], requirements: "- A guest can check out without an account\n- Expired cards are rejected before payment" }), 200);
    const requirements = cases.filter(item => item.category === "Requirement");
    expect(requirements.map(item => item.description)).toEqual(["A guest can check out without an account", "Expired cards are rejected before payment"]);
  });

  it("is deterministic, has unique ids, numbered steps, and respects the cap", () => {
    const first = generateManualCases(input({ testingTypes: [...manualTestingTypes] }), 500);
    expect(generateManualCases(input({ testingTypes: [...manualTestingTypes] }), 500)).toEqual(first);
    expect(new Set(first.map(item => item.testCaseId)).size).toBe(first.length);
    for (const item of first) {
      expect(item.testCaseId).toMatch(/^TC-[A-Z0-9]+-\d{3}$/);
      expect(item.steps.length).toBeGreaterThan(0);
      expect(item.steps.map(step => step.step)).toEqual(item.steps.map((_, index) => index + 1));
    }
    expect(generateManualCases(input({ testingTypes: [...manualTestingTypes] }), 7)).toHaveLength(7);
  });
});
