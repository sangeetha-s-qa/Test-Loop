import { z } from "zod";
import { applicationTypes, manualTestingTypes } from "./manual/catalog";

export const signupSchema = z.object({ email: z.string().email().max(254), name: z.string().trim().min(2).max(100), password: z.string().min(12).max(128), organizationName: z.string().trim().min(2).max(120) });
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) });
export const projectSchema = z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(2000).default(""), applicationUrl: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Only HTTP and HTTPS URLs are supported") });
export const environmentSchema = z.object({ name: z.string().trim().min(2).max(80), baseUrl: z.string().url() });
export const testRunSchema = z.object({
	projectId: z.string().uuid(),
	applicationUrl: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Only HTTP and HTTPS URLs are supported"),
	requirements: z.string().max(10000).default(""),
	testingTypes: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
	advancedSettings: z.object({ browser: z.enum(["chromium", "firefox", "webkit"]), viewport: z.enum(["desktop", "tablet", "mobile", "custom"]), customViewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) }).optional(), maxPages: z.number().int().min(1).max(500), maxTestCases: z.number().int().min(1).max(1000), timeoutSeconds: z.number().int().min(5).max(300), retryCount: z.number().int().min(0).max(5), captureScreenshots: z.boolean(), recordVideo: z.boolean(), captureTrace: z.boolean(), consoleLogging: z.boolean(), networkLogging: z.boolean(), visualThreshold: z.number().min(0).max(1) }),
	authorizationConfirmed: z.literal(true),
	// Optional with a default so every existing client that never sends it keeps creating exactly the
	// automated run it always did.
	testingMethod: z.enum(["AUTOMATED", "MANUAL"]).default("AUTOMATED"),
	applicationType: z.enum(applicationTypes).optional(),
}).superRefine((value, context) => {
	if (value.advancedSettings.viewport === "custom" && !value.advancedSettings.customViewport) context.addIssue({ code: z.ZodIssueCode.custom, path: ["advancedSettings", "customViewport"], message: "Custom viewport dimensions are required" });
	// The manual generator works from a fixed vocabulary; an unknown label would silently produce no
	// cases for it, so it is rejected here instead. Automated runs keep accepting their own labels.
	if (value.testingMethod === "MANUAL") {
		const unknown = value.testingTypes.filter(type => !(manualTestingTypes as readonly string[]).includes(type));
		if (unknown.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["testingTypes"], message: `Unsupported testing type for manual testing: ${unknown.join(", ")}` });
	}
});