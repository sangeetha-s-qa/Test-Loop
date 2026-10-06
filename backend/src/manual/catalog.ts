/**
 * Fixed vocabularies for manual testing.
 *
 * Application types mirror the `ApplicationType` Prisma enum one-for-one; `catalog.test.ts` keeps the
 * two in step. Testing types stay free strings on `TestRun.testingTypes` (that column predates this
 * module and the automated wizard sends its own labels), but a manual run only accepts the labels
 * below, so the generator never has to guess what an unknown label meant.
 */

export const applicationTypes = [
  "ECOMMERCE",
  "BANKING_FINTECH",
  "HEALTHCARE",
  "EDUCATION",
  "SOCIAL_MEDIA",
  "SAAS",
  "BOOKING",
  "LOGISTICS",
  "REAL_ESTATE",
  "ERP",
  "CONTENT_MEDIA",
  "GAMING",
  "ADMIN_PORTAL",
  "BUSINESS_CORPORATE",
  "OTHER",
] as const;

export type ApplicationTypeKey = (typeof applicationTypes)[number];

export const applicationTypeLabels: Record<ApplicationTypeKey, string> = {
  ECOMMERCE: "E-Commerce",
  BANKING_FINTECH: "Banking / FinTech",
  HEALTHCARE: "Healthcare",
  EDUCATION: "Education / E-Learning",
  SOCIAL_MEDIA: "Social Media",
  SAAS: "SaaS / Web Application",
  BOOKING: "Booking / Reservation",
  LOGISTICS: "Logistics / Delivery",
  REAL_ESTATE: "Real Estate",
  ERP: "ERP / Enterprise",
  CONTENT_MEDIA: "Content / Media",
  GAMING: "Gaming",
  ADMIN_PORTAL: "Admin / Management Portal",
  BUSINESS_CORPORATE: "Business / Corporate",
  OTHER: "Other",
};

export const manualTestingTypes = [
  "Functional",
  "UI/UX",
  "End-to-End",
  "Flow",
  "Smoke",
  "Sanity",
  "Regression",
  "Integration",
  "CRUD",
  "Accessibility",
  "Responsive",
  "Cross-browser",
  "Mobile",
  "Web",
  "API",
  "Security",
  "Performance",
  "Other",
] as const;

export type ManualTestingType = (typeof manualTestingTypes)[number];

export const manualStatuses = ["NOT_RUN", "IN_PROGRESS", "PASSED", "FAILED", "BLOCKED"] as const;
export type ManualStatus = (typeof manualStatuses)[number];

export const blockedReasons = [
  "ENVIRONMENT_UNAVAILABLE",
  "CREDENTIAL_UNAVAILABLE",
  "APPLICATION_UNAVAILABLE",
  "TEST_DATA_UNAVAILABLE",
  "BROWSER_ISSUE",
  "EXTERNAL_DEPENDENCY_UNAVAILABLE",
  "OTHER",
] as const;
export type BlockedReason = (typeof blockedReasons)[number];
