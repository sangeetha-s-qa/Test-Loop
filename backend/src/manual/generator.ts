import type { ApplicationTypeKey, ManualTestingType } from "./catalog";

/**
 * Generates manual test cases from what is actually known about the application.
 *
 * Deterministic on purpose: the same discovery data, application type, and testing types always
 * produce the same suite, it runs in milliseconds with no model, and every case can be traced to the
 * evidence it came from - a discovered form, field, link, page, or endpoint, or a line of the user's
 * requirements. Where a case covers something typical of the application type that discovery did
 * NOT observe, its preconditions say "Requires verification" rather than asserting the feature
 * exists. The existing AI generation pipeline remains available on top of this for deeper cases.
 *
 * Test data never contains a real credential. Wherever one is needed the case names a placeholder
 * (`<valid username for a test account>`) and the tester types the real value into the target
 * application themselves.
 */

export type GeneratorField = { name: string; type: string; label: string | null; required: boolean; placeholder?: string | null; autocomplete?: string | null };
export type GeneratorForm = { pageId: string; identifier: string; method: string; fields: GeneratorField[] };
export type GeneratorPage = { id: string; normalizedUrl: string; title: string; depth: number };
export type GeneratorLink = { pageId: string; normalizedUrl: string | null; visibleText: string; sameOrigin: boolean };
export type GeneratorEndpoint = { method: string; normalizedUrl: string; observedStatus: number | null };

export type GeneratorInput = {
  applicationUrl: string;
  applicationType: ApplicationTypeKey | null;
  testingTypes: string[];
  requirements: string;
  browser: string;
  discovery: { pages: GeneratorPage[]; forms: GeneratorForm[]; links: GeneratorLink[]; endpoints: GeneratorEndpoint[] } | null;
};

export type GeneratedStep = { step: number; action: string; expectedResult: string };
export type GeneratedCase = {
  testCaseId: string;
  title: string;
  description: string;
  module: string;
  category: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  preconditions: string;
  testData: Record<string, string>;
  steps: GeneratedStep[];
  expectedResult: string;
  postconditions: string;
  sourcePageId: string | null;
};

const prefixes: Record<string, string> = {
  Functional: "FUNC",
  "UI/UX": "UI",
  "End-to-End": "E2E",
  Flow: "FLOW",
  Smoke: "SMOKE",
  Sanity: "SANITY",
  Regression: "REG",
  Integration: "INT",
  CRUD: "CRUD",
  Accessibility: "A11Y",
  Responsive: "RESP",
  "Cross-browser": "XB",
  Mobile: "MOB",
  Web: "WEB",
  API: "API",
  Security: "SEC",
  Performance: "PERF",
  Other: "OTH",
  Requirement: "REQ",
};

const UNVERIFIED = "Requires verification: this feature was not observed during discovery. Mark the case Blocked if the application does not offer it.";

/** Per application type: the business flow an end-to-end case should walk, the main entity for CRUD, and the words that would show discovery saw it. */
const domainProfiles: Record<ApplicationTypeKey, { flow: string; entity: string; journey: string[]; integration: string; evidence: RegExp }> = {
  ECOMMERCE: { flow: "Purchase a product as a shopper", entity: "cart item", journey: ["Browse the catalogue and open a product", "Add the product to the cart", "Open the cart and verify item, quantity, and total", "Proceed to checkout and enter shipping details", "Complete payment with a sandbox payment method"], integration: "payment gateway", evidence: /product|shop|cart|checkout|catalog|store/i },
  BANKING_FINTECH: { flow: "Transfer funds between accounts", entity: "payee", journey: ["Sign in with a test account", "Open the accounts overview and note the balance", "Start a transfer to a test payee", "Confirm the transfer, completing any OTP step in the window", "Verify the transaction history and updated balance"], integration: "core banking / payment rail", evidence: /account|transfer|balance|payment|bank|wallet|transaction/i },
  HEALTHCARE: { flow: "Book an appointment as a patient", entity: "appointment", journey: ["Sign in with a test patient account", "Search for a provider or department", "Choose an available slot", "Confirm the appointment details", "Verify the appointment appears in the patient's list"], integration: "scheduling / notification service", evidence: /patient|doctor|appointment|clinic|health|provider/i },
  EDUCATION: { flow: "Enrol in a course and open a lesson", entity: "enrolment", journey: ["Sign in with a test learner account", "Browse the course catalogue", "Open a course and enrol", "Open the first lesson", "Verify progress is recorded"], integration: "video / content delivery", evidence: /course|lesson|learn|class|student|quiz/i },
  SOCIAL_MEDIA: { flow: "Create a post and interact with it", entity: "post", journey: ["Sign in with a test account", "Create a post with text", "Verify the post appears in the feed", "Like and comment on the post", "Verify counts update"], integration: "media upload / notification service", evidence: /post|feed|profile|follow|comment|like|share/i },
  SAAS: { flow: "Sign in and complete the core workflow", entity: "workspace record", journey: ["Sign in with a test account", "Open the main dashboard", "Create a new record in the primary module", "Edit and save the record", "Verify the change is visible after reload"], integration: "third-party integration (e.g. email, SSO)", evidence: /dashboard|workspace|settings|account|app|project/i },
  BOOKING: { flow: "Search availability and make a reservation", entity: "reservation", journey: ["Search with a destination or service and a date range", "Choose an available option", "Enter guest details", "Confirm the reservation", "Verify the confirmation and reservation reference"], integration: "availability / payment provider", evidence: /book|reserv|availability|hotel|ticket|room|slot/i },
  LOGISTICS: { flow: "Create a shipment and track it", entity: "shipment", journey: ["Sign in with a test account", "Create a shipment with sender and receiver", "Note the tracking number", "Open tracking and search the number", "Verify the shipment status is shown"], integration: "carrier / tracking API", evidence: /ship|track|deliver|order|parcel|courier/i },
  REAL_ESTATE: { flow: "Search listings and contact an agent", entity: "saved listing", journey: ["Search listings with location and price filters", "Open a listing", "Review photos, price, and details", "Save the listing", "Submit the contact-agent form"], integration: "maps / lead notification", evidence: /property|listing|rent|buy|agent|home|estate/i },
  ERP: { flow: "Create and approve a business document", entity: "purchase order", journey: ["Sign in with a test user", "Create a purchase order with line items", "Submit it for approval", "Approve it as an approver role", "Verify status and totals"], integration: "accounting / inventory module", evidence: /order|invoice|inventory|approval|report|employee/i },
  CONTENT_MEDIA: { flow: "Find and consume a piece of content", entity: "article", journey: ["Open the home page", "Search or browse to an article or video", "Open it and verify it renders fully", "Share or bookmark it", "Verify related content loads"], integration: "media / CDN", evidence: /article|news|video|watch|read|blog|media/i },
  GAMING: { flow: "Start and complete a game session", entity: "player profile", journey: ["Sign in with a test player account", "Open the game lobby", "Start a session", "Complete or exit the session", "Verify score or progress is saved"], integration: "leaderboard / payment", evidence: /game|play|score|level|leaderboard|player/i },
  ADMIN_PORTAL: { flow: "Manage a record as an administrator", entity: "user record", journey: ["Sign in with a test administrator account", "Open the management list", "Search for and open a record", "Edit a field and save", "Verify the change in the list and the audit trail"], integration: "identity / audit service", evidence: /admin|manage|users|roles|settings|dashboard/i },
  BUSINESS_CORPORATE: { flow: "Find information and submit an enquiry", entity: "enquiry", journey: ["Open the home page", "Navigate to services or about pages", "Open the contact page", "Submit the enquiry form", "Verify the confirmation"], integration: "email / CRM", evidence: /about|contact|service|team|career|company/i },
  OTHER: { flow: "Complete the application's primary user journey", entity: "primary record", journey: ["Open the application", "Navigate to the primary feature", "Perform its main action", "Verify the outcome", "Return to the start page"], integration: "external dependency", evidence: /./ },
};

const pathOf = (url: string, base: string) => {
  try {
    const target = new URL(url);
    const root = new URL(base);
    return target.origin === root.origin ? `${target.pathname}${target.search}` || "/" : target.toString();
  } catch {
    return url;
  }
};

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const fieldName = (field: GeneratorField) => clip((field.label?.trim() || field.placeholder?.trim() || field.name || field.type || "field").replace(/\s+/g, " "), 60);
const isPassword = (field: GeneratorField) => field.type === "password" || /password/i.test(field.autocomplete ?? "");
const isEmail = (field: GeneratorField) => field.type === "email" || /email/i.test(`${field.name} ${field.autocomplete ?? ""}`);
const isSearch = (form: GeneratorForm) => form.fields.some(field => field.type === "search" || /^(q|query|search|s)$/i.test(field.name));

/** Placeholder test data per field. Never a real secret, always something a person replaces. */
function sampleValue(field: GeneratorField): string {
  if (isPassword(field)) return "<password for the test account - type it in the testing window>";
  if (isEmail(field)) return "qa.tester@example.com";
  if (field.type === "number") return "10";
  if (field.type === "tel") return "+1 555 0100";
  if (field.type === "url") return "https://example.com";
  if (field.type === "date") return "a valid future date";
  if (/user|login/i.test(field.name)) return "<valid username for a test account>";
  if (/name/i.test(field.name)) return "QA Tester";
  return `Valid ${fieldName(field).toLowerCase()}`;
}

export function generateManualCases(input: GeneratorInput, maxCases: number): GeneratedCase[] {
  const types = new Set(input.testingTypes as ManualTestingType[]);
  const cases: GeneratedCase[] = [];
  const titles = new Set<string>();
  const counters = new Map<string, number>();
  const base = input.applicationUrl;
  const pages = input.discovery?.pages.length ? input.discovery.pages : [{ id: "", normalizedUrl: base, title: new URL(base).hostname, depth: 0 }];
  const home = pages.find(page => page.depth === 0) ?? pages[0];
  const forms = input.discovery?.forms ?? [];
  const links = input.discovery?.links ?? [];
  const endpoints = input.discovery?.endpoints ?? [];
  const pageById = new Map(pages.map(page => [page.id, page]));
  const profile = domainProfiles[input.applicationType ?? "OTHER"];
  const corpus = [...pages.map(page => `${page.title} ${page.normalizedUrl}`), ...links.map(link => `${link.visibleText} ${link.normalizedUrl ?? ""}`)].join(" ");
  const domainObserved = input.applicationType !== null && input.applicationType !== "OTHER" && profile.evidence.test(corpus);
  const loginForms = forms.filter(form => form.fields.some(isPassword));
  const dataForms = forms.filter(form => !form.fields.some(isPassword) && !isSearch(form) && form.fields.length > 0);
  const searchForms = forms.filter(isSearch);
  const navLinks = [...new Map(links.filter(link => link.sameOrigin && link.normalizedUrl && link.visibleText.trim()).map(link => [link.normalizedUrl!, link])).values()];
  const pageLabel = (page: GeneratorPage) => `${clip(page.title || pathOf(page.normalizedUrl, base), 50)} (${pathOf(page.normalizedUrl, base)})`;
  const formLabel = (form: GeneratorForm) => {
    const page = pageById.get(form.pageId);
    return `${form.identifier ? `"${clip(form.identifier, 40)}" form` : "form"} on ${page ? pathOf(page.normalizedUrl, base) : "the page"}`;
  };

  const add = (category: string, spec: Omit<GeneratedCase, "testCaseId" | "category" | "description" | "postconditions" | "testData" | "severity"> & Partial<Pick<GeneratedCase, "description" | "postconditions" | "testData" | "severity">>) => {
    if (cases.length >= maxCases) return;
    const key = spec.title.toLowerCase();
    if (titles.has(key)) return;
    titles.add(key);
    const prefix = prefixes[category] ?? "OTH";
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    cases.push({
      testCaseId: `TC-${prefix}-${String(next).padStart(3, "0")}`,
      category,
      description: spec.description ?? spec.title,
      postconditions: spec.postconditions ?? "",
      testData: spec.testData ?? {},
      severity: spec.severity ?? spec.priority,
      ...spec,
      steps: spec.steps.map((step, index) => ({ ...step, step: index + 1 })),
    });
  };
  const s = (action: string, expectedResult: string): GeneratedStep => ({ step: 0, action, expectedResult });
  const open = (page: GeneratorPage) => s(`Open ${pathOf(page.normalizedUrl, base)}`, `The page "${clip(page.title || "page", 60)}" loads without errors`);

  /* ---------------------------------------------------------------- Smoke */
  if (types.has("Smoke")) {
    add("Smoke", { title: "Application home page loads", module: "Core", priority: "CRITICAL", preconditions: "The application URL is reachable from the testing machine.", sourcePageId: home.id || null, steps: [s(`Open ${base}`, "The page responds and renders its main content"), s("Check the page title and primary navigation", "Title and navigation are present and readable"), s("Open the browser developer console", "No uncaught errors are shown on load")], expectedResult: "The home page loads completely with navigation and no console errors." });
    for (const page of pages.filter(page => page.depth === 1).slice(0, 5)) {
      add("Smoke", { title: `${clip(page.title || pathOf(page.normalizedUrl, base), 60)} page is reachable`, module: "Navigation", priority: "HIGH", preconditions: "The home page loads.", sourcePageId: page.id || null, steps: [open(home), s(`Navigate to ${pathOf(page.normalizedUrl, base)}`, "The page loads"), s("Check the main heading and content area", "Content renders and is not an error page")], expectedResult: `${pageLabel(page)} loads with its expected content.` });
    }
    if (loginForms.length) add("Smoke", { title: "Test account can sign in", module: "Authentication", priority: "CRITICAL", preconditions: "A test account exists for this environment.", sourcePageId: loginForms[0].pageId || null, testData: { username: "<valid username for a test account>", password: "<type it in the testing window>" }, steps: [s(`Open the ${formLabel(loginForms[0])}`, "The sign-in form is shown"), s("Enter valid test credentials and submit", "The form submits"), s("Observe the landing page", "The signed-in area is shown")], expectedResult: "A valid test account signs in successfully." });
  }

  /* ---------------------------------------------------------------- Functional: authentication */
  if (types.has("Functional") || types.has("Security")) {
    for (const form of loginForms.slice(0, 2)) {
      const user = form.fields.find(field => !isPassword(field)) ?? null;
      const pageId = form.pageId || null;
      add("Functional", { title: "Sign in with valid credentials", module: "Authentication", priority: "CRITICAL", preconditions: "A test account exists. Sign in inside the testing window; the platform never asks for or stores the password.", sourcePageId: pageId, testData: { [user ? fieldName(user) : "username"]: "<valid username for a test account>", password: "<type it in the testing window>" }, steps: [s(`Open the ${formLabel(form)}`, "The sign-in form is displayed"), s(`Enter a valid ${user ? fieldName(user).toLowerCase() : "username"}`, "The value is accepted"), s("Enter the matching password", "The password is masked"), s("Submit the form", "The user is authenticated and redirected to the signed-in area")], expectedResult: "The user is authenticated and lands on the signed-in page." });
      add("Functional", { title: "Sign in with an invalid password is rejected", module: "Authentication", priority: "HIGH", preconditions: "User is on the sign-in page.", sourcePageId: pageId, testData: { username: "<valid username for a test account>", password: "<any incorrect password, e.g. wrong-password-123>" }, steps: [s(`Open the ${formLabel(form)}`, "The sign-in form is displayed"), s("Enter a valid username", "The value is accepted"), s("Enter an incorrect password", "The password is masked"), s("Submit the form", "Submission is processed"), s("Observe the response", "An error message is shown and the user stays signed out")], expectedResult: "The user is not authenticated and an appropriate error message is displayed that does not reveal which field was wrong." });
      add("Functional", { title: "Sign in with empty fields shows validation", module: "Authentication", priority: "HIGH", preconditions: "User is on the sign-in page.", sourcePageId: pageId, steps: [s(`Open the ${formLabel(form)}`, "The sign-in form is displayed"), s("Leave every field empty and submit", "Submission is blocked or rejected"), s("Observe each field", "Required-field messages are shown")], expectedResult: "The form cannot be submitted empty and the user is told which fields are required." });
      add("Functional", { title: "Password field masks its input", module: "Authentication", priority: "MEDIUM", preconditions: "User is on the sign-in page.", sourcePageId: pageId, steps: [s(`Open the ${formLabel(form)}`, "The sign-in form is displayed"), s("Type characters into the password field", "Characters are rendered as dots or bullets"), s("Use the show-password control if present", "The value is revealed only on explicit request")], expectedResult: "The password is never displayed in clear text unless the user chooses to reveal it." });
    }
  }

  /* ---------------------------------------------------------------- Functional: forms */
  if (types.has("Functional")) {
    for (const form of dataForms.slice(0, 6)) {
      const pageId = form.pageId || null;
      const fields = form.fields.filter(field => !["hidden", "submit", "button"].includes(field.type));
      const data = Object.fromEntries(fields.slice(0, 10).map(field => [fieldName(field), sampleValue(field)]));
      add("Functional", { title: `Submit the ${formLabel(form)} with valid data`, module: "Forms", priority: "HIGH", preconditions: "User is on the page containing the form.", sourcePageId: pageId, testData: data, steps: [s(`Open the ${formLabel(form)}`, "The form is displayed"), ...fields.slice(0, 6).map(field => s(`Enter "${sampleValue(field)}" in ${fieldName(field)}`, "The value is accepted")), s("Submit the form", "A success confirmation is shown")], expectedResult: "The form submits successfully and a clear confirmation is displayed." });
      for (const field of fields.filter(field => field.required).slice(0, 3)) {
        add("Functional", { title: `${formLabel(form)}: ${fieldName(field)} is required`, module: "Forms", priority: "HIGH", preconditions: "User is on the page containing the form.", sourcePageId: pageId, steps: [s(`Open the ${formLabel(form)}`, "The form is displayed"), s(`Fill every field except ${fieldName(field)}`, "Values are accepted"), s("Submit the form", "Submission is blocked"), s(`Observe ${fieldName(field)}`, "A required-field message is shown next to it")], expectedResult: `The form is not submitted and ${fieldName(field)} is flagged as required.` });
      }
      for (const field of fields.filter(isEmail).slice(0, 2)) {
        add("Functional", { title: `${formLabel(form)}: invalid email format is rejected`, module: "Forms", priority: "HIGH", preconditions: "User is on the page containing the form.", sourcePageId: pageId, testData: { [fieldName(field)]: "user@example" }, steps: [s(`Open the ${formLabel(form)}`, "The form is displayed"), s(`Enter "user@example" in ${fieldName(field)}`, "The value is typed"), s("Fill the remaining fields with valid data and submit", "Submission is blocked"), s(`Observe ${fieldName(field)}`, "An invalid-format message is shown")], expectedResult: "An email without a valid domain is rejected with a clear message." });
      }
      if (fields.length) {
        add("Functional", { title: `${formLabel(form)}: whitespace-only input is not accepted`, module: "Forms", priority: "MEDIUM", preconditions: "User is on the page containing the form.", sourcePageId: pageId, steps: [s(`Open the ${formLabel(form)}`, "The form is displayed"), s(`Enter only spaces in ${fieldName(fields[0])}`, "The value is typed"), s("Submit the form", "Submission is blocked or the value is trimmed and rejected")], expectedResult: "Whitespace-only input is treated as empty and validated accordingly." });
        add("Functional", { title: `${formLabel(form)}: maximum-length input is handled`, module: "Forms", priority: "MEDIUM", preconditions: "User is on the page containing the form.", sourcePageId: pageId, testData: { [fieldName(fields[0])]: "A string of 500+ characters" }, steps: [s(`Open the ${formLabel(form)}`, "The form is displayed"), s(`Paste a 500+ character string into ${fieldName(fields[0])}`, "Input is limited or accepted"), s("Submit the form", "The response is either a length message or a successful submission"), s("Observe the page layout", "Nothing overflows or breaks")], expectedResult: "Over-long input is either limited with a message or stored intact - never truncated silently or crashing the page." });
        add("Functional", { title: `${formLabel(form)}: special characters are handled safely`, module: "Forms", priority: "MEDIUM", preconditions: "User is on the page containing the form.", sourcePageId: pageId, testData: { [fieldName(fields[0])]: "O'Brien <b>bold</b> & \"quotes\" 😀" }, steps: [s(`Open the ${formLabel(form)}`, "The form is displayed"), s(`Enter O'Brien <b>bold</b> & "quotes" 😀 in ${fieldName(fields[0])}`, "The value is typed"), s("Submit and view any page that echoes the value", "The text is shown literally")], expectedResult: "Special characters are stored and displayed literally; markup is not rendered as HTML." });
      }
    }
    for (const form of searchForms.slice(0, 2)) {
      const pageId = form.pageId || null;
      add("Functional", { title: "Search returns relevant results for an existing term", module: "Search", priority: "HIGH", preconditions: "Content exists that matches a known term.", sourcePageId: pageId, testData: { term: "<a term known to exist on the site>" }, steps: [s(`Open the ${formLabel(form)}`, "The search box is shown"), s("Search for a known term", "Results load"), s("Open the first result", "It relates to the term")], expectedResult: "Results are relevant to the search term." });
      add("Functional", { title: "Search with no matches shows an empty state", module: "Search", priority: "MEDIUM", preconditions: "None.", sourcePageId: pageId, testData: { term: "zzqx-no-such-term" }, steps: [s(`Open the ${formLabel(form)}`, "The search box is shown"), s('Search for "zzqx-no-such-term"', "The search completes"), s("Observe the results area", "A clear no-results message is shown")], expectedResult: "A helpful empty state is shown instead of an error or a blank page." });
    }
    if (!forms.length) add("Functional", { title: "Primary call-to-action performs its action", module: "Core", priority: "HIGH", preconditions: input.discovery ? "Discovery found no forms; identify the page's main action manually." : "No discovery data: identify the page's main action manually.", sourcePageId: home.id || null, steps: [s(`Open ${base}`, "The page loads"), s("Activate the most prominent button or link", "The expected action happens"), s("Observe the result", "The user gets clear feedback")], expectedResult: "The primary action completes and gives clear feedback." });
    add("Functional", { title: "Unknown URL shows a not-found page", module: "Error handling", priority: "MEDIUM", preconditions: "None.", sourcePageId: null, steps: [s(`Open ${new URL("/this-page-does-not-exist-qa", base).toString()}`, "The server responds"), s("Observe the page", "A not-found page is shown"), s("Use its navigation to return home", "The home page loads")], expectedResult: "A friendly 404 page with a way back is shown; no stack trace or server detail is exposed." });
  }

  /* ---------------------------------------------------------------- Navigation / flow */
  if (types.has("Flow") || types.has("Functional") || types.has("Web")) {
    for (const link of navLinks.slice(0, 8)) {
      const from = pageById.get(link.pageId) ?? home;
      add("Flow", { title: `"${clip(link.visibleText.trim(), 40)}" link opens the right page`, module: "Navigation", priority: "MEDIUM", preconditions: "None.", sourcePageId: from.id || null, steps: [open(from), s(`Click the "${clip(link.visibleText.trim(), 40)}" link`, "Navigation happens"), s("Check the URL and page heading", `The browser is on ${pathOf(link.normalizedUrl!, base)} with matching content`)], expectedResult: `The link leads to ${pathOf(link.normalizedUrl!, base)}.` });
    }
    add("Flow", { title: "Browser back and forward keep navigation consistent", module: "Navigation", priority: "MEDIUM", preconditions: "None.", sourcePageId: home.id || null, steps: [open(home), s("Navigate to two further pages", "Each page loads"), s("Press Back twice", "Each previous page is restored"), s("Press Forward", "The next page is restored without resubmitting forms")], expectedResult: "History navigation restores pages correctly and never resubmits a form silently." });
  }

  /* ---------------------------------------------------------------- End-to-end */
  if (types.has("End-to-End")) {
    add("End-to-End", { title: profile.flow, module: "Business flow", priority: "CRITICAL", preconditions: domainObserved ? "A test account and test data exist for this environment." : UNVERIFIED, sourcePageId: home.id || null, steps: profile.journey.map((action, index) => s(action, index === profile.journey.length - 1 ? "The flow completes and its result is persisted" : "The step completes without errors")), expectedResult: `The full "${profile.flow.toLowerCase()}" journey completes and its result is visible afterwards.` });
    if (loginForms.length) add("End-to-End", { title: "Sign in, use the application, and sign out", module: "Session", priority: "HIGH", preconditions: "A test account exists.", sourcePageId: loginForms[0].pageId || null, steps: [s("Sign in with the test account", "The signed-in area is shown"), s("Navigate through two signed-in pages", "Each loads with user-specific content"), s("Sign out", "The user is returned to a public page"), s("Press Back", "Signed-in content is not shown again")], expectedResult: "The session starts and ends cleanly; signed-in pages are not reachable after sign-out." });
  }

  /* ---------------------------------------------------------------- CRUD */
  if (types.has("CRUD")) {
    const verified = domainObserved ? "A test account with permission to manage records exists." : UNVERIFIED;
    for (const [verb, priority, detail] of [["Create", "HIGH", "a new"], ["View", "MEDIUM", "an existing"], ["Update", "HIGH", "an existing"], ["Delete", "HIGH", "an existing"]] as const) {
      add("CRUD", { title: `${verb} ${detail} ${profile.entity}`, module: "Data management", priority, preconditions: verified, sourcePageId: null, steps: [s(`Open the area where ${profile.entity}s are managed`, "The list is shown"), s(`${verb} ${detail} ${profile.entity}${verb === "Delete" ? " and confirm the prompt" : ""}`, "The action is accepted"), s("Reload the page", verb === "Delete" ? "The record no longer appears" : "The change is still present")], expectedResult: `${verb} of a ${profile.entity} is persisted and survives a reload.` });
    }
  }

  /* ---------------------------------------------------------------- Integration */
  if (types.has("Integration")) {
    add("Integration", { title: `Interaction with the ${profile.integration} succeeds`, module: "Integration", priority: "HIGH", preconditions: domainObserved ? `A sandbox ${profile.integration} is configured for this environment.` : UNVERIFIED, sourcePageId: null, steps: [s(`Trigger an action that calls the ${profile.integration}`, "The request is sent"), s("Observe the response in the UI", "Success feedback is shown"), s("Verify the result where the external system reflects it", "The change is visible")], expectedResult: "The integration completes and both systems agree on the result." });
    add("Integration", { title: `Failure of the ${profile.integration} is handled gracefully`, module: "Integration", priority: "MEDIUM", preconditions: domainObserved ? "The dependency can be made unavailable in this environment." : UNVERIFIED, sourcePageId: null, steps: [s("Make the dependency unavailable (or use its sandbox failure mode)", "It is unavailable"), s("Trigger the dependent action", "The request fails"), s("Observe the UI", "A clear, recoverable error message is shown")], expectedResult: "The user sees an understandable error and no data is left half-written." });
    for (const form of dataForms.slice(0, 2)) add("Integration", { title: `Data submitted through the ${formLabel(form)} is persisted`, module: "Integration", priority: "MEDIUM", preconditions: "Access to wherever the submission is stored or delivered.", sourcePageId: form.pageId || null, steps: [s(`Submit the ${formLabel(form)} with valid data`, "Confirmation is shown"), s("Check where the data is stored or delivered", "The submission is present with the same values")], expectedResult: "What the user submitted is what the backend recorded." });
  }

  /* ---------------------------------------------------------------- UI/UX */
  if (types.has("UI/UX")) {
    for (const page of pages.slice(0, 4)) add("UI/UX", { title: `${clip(page.title || pathOf(page.normalizedUrl, base), 50)}: layout and visual consistency`, module: "UI", priority: "MEDIUM", preconditions: "None.", sourcePageId: page.id || null, steps: [open(page), s("Compare header, footer, fonts, and colours with the home page", "They are consistent"), s("Look for overlapping, clipped, or misaligned elements", "None are present"), s("Check every image", "No image is broken or distorted")], expectedResult: "The page is visually consistent with the rest of the application, with no broken images or layout defects." });
    add("UI/UX", { title: "Interactive elements show hover, focus, and disabled states", module: "UI", priority: "LOW", preconditions: "None.", sourcePageId: home.id || null, steps: [open(home), s("Hover over buttons and links", "A hover state is visible"), s("Tab through controls", "A focus indicator is visible"), s("Find a disabled control if any", "It looks disabled and does not react")], expectedResult: "Every interactive element communicates its state." });
    for (const form of forms.slice(0, 2)) add("UI/UX", { title: `${formLabel(form)}: error messages are clear and placed next to fields`, module: "UI", priority: "MEDIUM", preconditions: "None.", sourcePageId: form.pageId || null, steps: [s(`Open the ${formLabel(form)}`, "The form is shown"), s("Submit it with invalid data", "Errors appear"), s("Read each message", "Each says what is wrong and how to fix it, next to the field")], expectedResult: "Validation errors are specific, readable, and attached to their fields." });
  }

  /* ---------------------------------------------------------------- Accessibility */
  if (types.has("Accessibility")) {
    add("Accessibility", { title: "Whole page is operable by keyboard alone", module: "Accessibility", priority: "HIGH", preconditions: "Put the mouse aside.", sourcePageId: home.id || null, steps: [open(home), s("Press Tab repeatedly through the page", "Focus moves in a logical order and is always visible"), s("Activate links and buttons with Enter/Space", "They work"), s("Check for keyboard traps", "Focus can always move on")], expectedResult: "Everything is reachable and operable with the keyboard, with a visible focus indicator." });
    for (const form of forms.slice(0, 3)) {
      const unlabeled = form.fields.filter(field => !field.label?.trim() && !["hidden", "submit", "button"].includes(field.type));
      add("Accessibility", { title: `${formLabel(form)}: every field has an accessible label`, module: "Accessibility", priority: unlabeled.length ? "HIGH" : "MEDIUM", preconditions: unlabeled.length ? `Discovery found ${unlabeled.length} field(s) with no visible label: ${unlabeled.map(fieldName).join(", ")}.` : "None.", sourcePageId: form.pageId || null, steps: [s(`Open the ${formLabel(form)}`, "The form is shown"), s("Click each field's label text", "The matching field receives focus"), s("Inspect each field with a screen reader or the accessibility tree", "Each field announces a meaningful name")], expectedResult: "Every form control has a programmatically associated, meaningful label." });
    }
    add("Accessibility", { title: "Images have meaningful alternative text", module: "Accessibility", priority: "MEDIUM", preconditions: "None.", sourcePageId: home.id || null, steps: [open(home), s("Inspect each informative image", "It has descriptive alt text"), s("Inspect decorative images", "They have empty alt text")], expectedResult: "Informative images are described; decorative ones are ignored by assistive technology." });
    add("Accessibility", { title: "Text colour contrast meets WCAG AA", module: "Accessibility", priority: "MEDIUM", preconditions: "A contrast checker is available.", sourcePageId: home.id || null, steps: [open(home), s("Check body text, links, and button labels with a contrast checker", "Ratios are at least 4.5:1 (3:1 for large text)")], expectedResult: "All text meets WCAG 2.1 AA contrast." });
    add("Accessibility", { title: "Page is usable at 200% zoom", module: "Accessibility", priority: "LOW", preconditions: "None.", sourcePageId: home.id || null, steps: [open(home), s("Zoom the browser to 200%", "The page reflows"), s("Read and use the main content", "Nothing is cut off or overlapping")], expectedResult: "Content remains readable and usable at 200% zoom." });
  }

  /* ---------------------------------------------------------------- Responsive / mobile */
  if (types.has("Responsive") || types.has("Mobile")) {
    const category = types.has("Responsive") ? "Responsive" : "Mobile";
    for (const [label, size] of [["mobile (390×844)", "390×844"], ["tablet (768×1024)", "768×1024"], ["desktop (1440×900)", "1440×900"]] as const) {
      add(category, { title: `Layout adapts at ${label}`, module: "Responsive", priority: label.startsWith("mobile") ? "HIGH" : "MEDIUM", preconditions: "Use the browser's device toolbar or resize the testing window.", sourcePageId: home.id || null, testData: { viewport: size }, steps: [s(`Set the viewport to ${size}`, "The page re-renders"), open(home), s("Scroll the full page", "There is no horizontal scrolling and nothing overlaps"), s("Open the navigation", "It is usable at this size")], expectedResult: `The layout is usable at ${label} with no horizontal scroll or clipped content.` });
    }
  }
  if (types.has("Mobile")) {
    add("Mobile", { title: "Touch targets are large enough and spaced", module: "Mobile", priority: "MEDIUM", preconditions: "Mobile viewport or a real device.", sourcePageId: home.id || null, steps: [s("Open the application in a mobile viewport", "The page loads"), s("Tap each button and link in the navigation", "The intended target activates, not a neighbour")], expectedResult: "Interactive targets are at least about 44×44 px and do not overlap." });
    add("Mobile", { title: "Orientation change keeps state and layout", module: "Mobile", priority: "LOW", preconditions: "Mobile viewport or a real device.", sourcePageId: home.id || null, steps: [s("Fill part of a form in portrait", "Values are entered"), s("Rotate to landscape", "Layout adapts"), s("Rotate back", "Entered values are still present")], expectedResult: "Rotating the device keeps entered data and a usable layout." });
  }

  /* ---------------------------------------------------------------- Cross-browser */
  if (types.has("Cross-browser")) {
    for (const browser of ["Chromium (Chrome / Edge)", "Firefox", "WebKit (Safari)"]) add("Cross-browser", { title: `Core pages and forms work in ${browser}`, module: "Compatibility", priority: browser.startsWith("Chromium") ? "HIGH" : "MEDIUM", preconditions: `${browser} is available on the testing machine.`, sourcePageId: home.id || null, steps: [s(`Open ${base} in ${browser}`, "The page renders"), s("Visit the main navigation pages", "Each renders like in the reference browser"), s(forms.length ? `Submit the ${formLabel(forms[0])}` : "Use the primary action", "It behaves like in the reference browser")], expectedResult: `Rendering and behaviour in ${browser} match the reference browser.` });
  }

  /* ---------------------------------------------------------------- Web */
  if (types.has("Web")) {
    add("Web", { title: "Reloading a page keeps the user's place", module: "Web", priority: "MEDIUM", preconditions: "None.", sourcePageId: home.id || null, steps: [s("Navigate to an inner page", "It loads"), s("Reload the page", "The same page and state are shown")], expectedResult: "A reload never loses the user's place or signs them out unexpectedly." });
    add("Web", { title: "Every page has a meaningful title", module: "Web", priority: "LOW", preconditions: "None.", sourcePageId: home.id || null, steps: pages.slice(0, 5).map(page => s(`Open ${pathOf(page.normalizedUrl, base)}`, "The browser tab shows a specific, meaningful title")), expectedResult: "Each page has a distinct title describing its content." });
  }

  /* ---------------------------------------------------------------- API */
  if (types.has("API")) {
    for (const endpoint of endpoints.slice(0, 6)) add("API", { title: `${endpoint.method} ${clip(pathOf(endpoint.normalizedUrl, base), 60)} responds correctly`, module: "API", priority: "MEDIUM", preconditions: "Browser developer tools are open on the Network tab.", sourcePageId: null, steps: [s("Use the page that triggers this request", "The request is sent"), s(`Find ${endpoint.method} ${pathOf(endpoint.normalizedUrl, base)} in the Network tab`, `Status is ${endpoint.observedStatus ?? "2xx"}`), s("Inspect the response body", "It is well-formed and the UI reflects it")], expectedResult: "The endpoint returns a successful, well-formed response that the UI renders correctly." });
    add("API", { title: "UI handles a failed API request gracefully", module: "API", priority: "MEDIUM", preconditions: "Developer tools can block requests or simulate offline.", sourcePageId: null, steps: [s("Block the page's data requests or go offline in developer tools", "Requests fail"), s("Reload or trigger the data load", "The UI responds"), s("Observe the UI", "A clear error state is shown, not a blank or broken page")], expectedResult: "A failed request produces a clear, recoverable error state." });
    if (!endpoints.length) add("API", { title: "Data requests made by the UI succeed", module: "API", priority: "MEDIUM", preconditions: input.discovery ? "Discovery observed no API traffic; verify in developer tools." : "No discovery data; verify in developer tools.", sourcePageId: null, steps: [s("Open developer tools on the Network tab and use the application", "Requests are listed"), s("Check the status of each XHR/fetch request", "None fail unexpectedly")], expectedResult: "No unexpected failed requests while using the application." });
  }

  /* ---------------------------------------------------------------- Security (authorized, non-destructive only) */
  if (types.has("Security")) {
    add("Security", { title: "Application is served over HTTPS", module: "Security", priority: "HIGH", preconditions: "None.", sourcePageId: home.id || null, steps: [s(`Open ${base.replace(/^https:/, "http:")}`, "The browser is redirected to HTTPS, or the HTTP origin is not offered"), s("Check the padlock / certificate", "The certificate is valid for this host")], expectedResult: "All traffic uses HTTPS with a valid certificate." });
    add("Security", { title: "Sensitive data never appears in the URL", module: "Security", priority: "HIGH", preconditions: "None.", sourcePageId: null, steps: [s("Submit each form in the application", "Submissions complete"), s("Inspect the address bar after each", "No password, token, or personal data appears in the URL")], expectedResult: "No credential or personal data is exposed in URLs." });
    if (loginForms.length) {
      add("Security", { title: "Signed-in pages are not reachable after sign-out", module: "Authorization", priority: "CRITICAL", preconditions: "A test account exists.", sourcePageId: loginForms[0].pageId || null, steps: [s("Sign in and note the URL of a signed-in page", "The page loads"), s("Sign out", "The user is signed out"), s("Paste the noted URL into the address bar", "The user is sent to sign-in, not shown the page")], expectedResult: "Protected pages require an active session." });
      add("Security", { title: "A lower-privilege account cannot open an admin-only page", module: "Authorization", priority: "HIGH", preconditions: "Two test accounts with different roles exist. If the application has a single role, mark this Blocked with reason Test data unavailable.", sourcePageId: null, steps: [s("Sign in as the higher-privilege account and note an admin-only URL", "The page loads"), s("Sign out and sign in as the lower-privilege account", "Signed in"), s("Open the noted URL directly", "Access is denied with a clear message")], expectedResult: "Authorization is enforced on the server, not only by hiding links." });
      add("Security", { title: "Repeated failed sign-ins are throttled or locked", module: "Authentication", priority: "MEDIUM", preconditions: "Use a dedicated test account you are authorised to lock.", sourcePageId: loginForms[0].pageId || null, steps: [s("Attempt to sign in with a wrong password five times", "Each attempt is rejected"), s("Observe the response after repeated failures", "A delay, CAPTCHA, or lockout message appears")], expectedResult: "Brute-force attempts are slowed or blocked." });
    }
  }

  /* ---------------------------------------------------------------- Performance (perceived) */
  if (types.has("Performance")) {
    for (const page of pages.slice(0, 3)) add("Performance", { title: `${clip(page.title || pathOf(page.normalizedUrl, base), 50)} loads within an acceptable time`, module: "Performance", priority: "MEDIUM", preconditions: "Developer tools open with cache disabled.", sourcePageId: page.id || null, testData: { budget: "Main content visible within 3 seconds on a normal connection" }, steps: [s("Disable cache in developer tools", "Cache is off"), open(page), s("Note when the main content becomes visible", "Within the budget")], expectedResult: "Main content appears within about 3 seconds on a normal connection." });
    add("Performance", { title: "Application stays usable on a slow connection", module: "Performance", priority: "LOW", preconditions: "Developer tools network throttling is available.", sourcePageId: home.id || null, steps: [s('Set network throttling to "Slow 4G"', "Throttling is on"), open(home), s("Use the main navigation", "Loading indicators are shown and nothing breaks")], expectedResult: "The application degrades gracefully with visible loading feedback." });
  }

  /* ---------------------------------------------------------------- Sanity / regression */
  if (types.has("Sanity")) {
    add("Sanity", { title: "Recently changed area works after deployment", module: "Sanity", priority: "HIGH", preconditions: "Know which feature changed in this build.", sourcePageId: null, steps: [s("Open the feature changed in this build", "It loads"), s("Perform its main action", "It succeeds"), s("Check the directly related pages", "They still work")], expectedResult: "The changed feature and its immediate neighbours work." });
    add("Sanity", { title: "Navigation and main pages respond after deployment", module: "Sanity", priority: "HIGH", preconditions: "None.", sourcePageId: home.id || null, steps: [open(home), ...pages.filter(page => page.depth === 1).slice(0, 3).map(page => s(`Open ${pathOf(page.normalizedUrl, base)}`, "It loads"))], expectedResult: "All main pages respond after the deployment." });
  }
  if (types.has("Regression")) {
    for (const form of [...loginForms, ...dataForms].slice(0, 3)) add("Regression", { title: `${formLabel(form)} still submits and validates as before`, module: "Regression", priority: "HIGH", preconditions: "Compare against the previous release's behaviour.", sourcePageId: form.pageId || null, steps: [s(`Submit the ${formLabel(form)} with valid data`, "It succeeds as in the previous release"), s("Submit it with invalid data", "The same validation messages appear")], expectedResult: "Form behaviour is unchanged from the previous release." });
    add("Regression", { title: "Previously working navigation still works", module: "Regression", priority: "MEDIUM", preconditions: "None.", sourcePageId: home.id || null, steps: navLinks.slice(0, 5).map(link => s(`Follow "${clip(link.visibleText.trim(), 40)}"`, `It reaches ${pathOf(link.normalizedUrl!, base)}`)).concat(navLinks.length ? [] : [s("Follow every link in the main navigation", "Each reaches its page")]), expectedResult: "No navigation path regressed." });
  }

  /* ---------------------------------------------------------------- Requirements and "Other" */
  const requirementLines = input.requirements
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .map(line => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(line => line.length >= 8)
    .slice(0, 15);
  for (const line of requirementLines) add("Requirement", { title: `Requirement: ${clip(line, 120)}`, description: line, module: "Requirements", priority: "HIGH", preconditions: "Derived from the requirements entered for this run.", sourcePageId: null, steps: [s("Set up the preconditions this requirement implies", "Ready"), s(`Exercise the behaviour described: ${clip(line, 160)}`, "The behaviour is observed"), s("Compare the outcome with the requirement", "They match")], expectedResult: `The application satisfies: ${clip(line, 250)}` });
  if (types.has("Other") && !requirementLines.length) add("Other", { title: "Exploratory session on the main user journey", module: "Exploratory", priority: "MEDIUM", preconditions: "Timebox the session to 30 minutes.", sourcePageId: home.id || null, steps: [s("Use the application as a new user would", "Behaviour is observed"), s("Try unexpected inputs and orders of actions", "The application copes"), s("Record anything surprising in the notes", "Findings are captured")], expectedResult: "No unexpected errors, dead ends, or confusing behaviour." });

  return cases;
}
