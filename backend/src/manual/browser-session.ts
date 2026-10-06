import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import { config, manualBrowserEnabled, manualBrowserHeadless } from "../config";
import { prisma } from "../db";
import { assertSafeUrl } from "../discovery/scope";

/**
 * Real browser windows for manual testing.
 *
 * A web page cannot open or control a window on the tester's operating system, so this does not
 * pretend to. What it does is launch a real, headed Playwright browser on the machine running the
 * control plane - which, in a local install, is the tester's own machine - pointed at the target
 * application. The tester drives it with their own mouse and keyboard; the platform only holds the
 * handle so it can take a screenshot when asked, and close the window when the run ends.
 *
 * The live handle exists only in this process. The `ManualBrowserSession` row is the durable record,
 * and every read reconciles the two, so the UI can never report a window as open when it is not.
 * This assumes one control-plane process, which is the only deployment in which a headed window on
 * the tester's desktop makes sense in the first place.
 */

const browserTypes: Record<string, BrowserType> = { chromium, firefox, webkit };

type LiveSession = {
  sessionId: string;
  testRunId: string;
  browser: Browser;
  context: BrowserContext;
  /** The page screenshots are taken from: the most recently opened tab that is still open. */
  pages: Page[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Set when the platform is the one closing the window, so the close is not reported as a crash. */
  closing: boolean;
};

const live = new Map<string, LiveSession>();

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export const sessionCapability = () =>
  manualBrowserEnabled
    ? { enabled: true as const, reason: null }
    : {
        enabled: false as const,
        reason:
          "This control plane is not running on your machine, so it cannot open a window you can see. Open the application in your own browser and attach screenshots with Upload. To get the controlled testing window, run Testloop locally with MANUAL_BROWSER_ENABLED=true.",
      };

/** Fields of a crash or launch failure that are safe to show: the first line, no page content. */
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300);

async function markEnded(sessionId: string, status: "CLOSED" | "CRASHED" | "FAILED", endReason: string, lastError?: string) {
  await prisma.manualBrowserSession
    .updateMany({ where: { id: sessionId, status: { in: ["STARTING", "ACTIVE"] } }, data: { status, endReason, endedAt: new Date(), ...(lastError ? { lastError } : {}) } })
    .catch(() => undefined);
}

function resetIdle(session: LiveSession) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void closeSession(session.testRunId, "IDLE_TIMEOUT");
  }, config.MANUAL_SESSION_IDLE_TIMEOUT_SECONDS * 1000);
  // A pending idle timer must not keep a test runner or a shutting-down server alive.
  session.idleTimer.unref?.();
}

async function touch(session: LiveSession) {
  resetIdle(session);
  await prisma.manualBrowserSession.updateMany({ where: { id: session.sessionId, status: "ACTIVE" }, data: { lastActivityAt: new Date() } }).catch(() => undefined);
}

/**
 * Tears down the browser. Safe to call more than once and from event handlers: the map entry is
 * removed first, so a `disconnected` event fired by our own `close()` finds nothing to do.
 */
async function teardown(session: LiveSession, status: "CLOSED" | "CRASHED", endReason: string, lastError?: string) {
  if (live.get(session.testRunId) === session) live.delete(session.testRunId);
  session.closing = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  await markEnded(session.sessionId, status, endReason, lastError);
  await session.browser.close().catch(() => undefined);
}

function watchPage(session: LiveSession, page: Page) {
  session.pages.push(page);
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) void touch(session);
  });
  page.on("crash", () => {
    if (!session.closing) void teardown(session, "CRASHED", "PAGE_CRASHED", "The page in the testing window crashed. Launch a new window to continue.");
  });
  page.on("close", () => {
    session.pages = session.pages.filter(item => item !== page);
    // The tester closed the last tab: the window is gone, so the session is too.
    if (!session.closing && session.pages.length === 0) void teardown(session, "CLOSED", "WINDOW_CLOSED");
  });
}

/**
 * Network guard for the testing window.
 *
 * Unlike automated execution this is NOT same-origin: a person testing a real application will
 * follow its single sign-on, payment, and CDN origins, and blocking them would make manual testing
 * of most applications impossible. What it does keep is the address policy - no private ranges, no
 * cloud metadata endpoint - checked once per origin, because those are never a legitimate part of a
 * target application reached from the control-plane host.
 */
async function installGuard(context: BrowserContext) {
  const verdicts = new Map<string, Promise<boolean>>();
  await context.route("**/*", async route => {
    const url = route.request().url();
    if (!/^https?:/i.test(url)) return route.continue();
    const origin = new URL(url).origin;
    if (!verdicts.has(origin)) {
      verdicts.set(
        origin,
        assertSafeUrl(origin, undefined, { allowLocalFixture: config.EXECUTION_ALLOW_LOCAL_FIXTURE }).then(
          () => true,
          () => false,
        ),
      );
    }
    return (await verdicts.get(origin)) ? route.continue() : route.abort("blockedbyclient");
  });
}

export type SessionView = {
  id: string;
  status: string;
  browser: string;
  targetUrl: string;
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  lastError: string | null;
  currentUrl: string | null;
};

/** Latest session for a run, reconciled with what is actually alive in this process. */
export async function getSession(testRunId: string): Promise<SessionView | null> {
  const row = await prisma.manualBrowserSession.findFirst({ where: { testRunId }, orderBy: { startedAt: "desc" } });
  if (!row) return null;
  const handle = live.get(testRunId);
  if ((row.status === "ACTIVE" || row.status === "STARTING") && (!handle || handle.sessionId !== row.id)) {
    // The row says open but nothing in this process holds the browser: the control plane restarted
    // or the handle was lost. Say so instead of showing a window that is not there.
    await markEnded(row.id, "CLOSED", "CONTROL_PLANE_RESTARTED");
    return { ...row, status: "CLOSED", endReason: "CONTROL_PLANE_RESTARTED", endedAt: new Date(), currentUrl: null };
  }
  const page = handle?.pages.at(-1);
  return { ...row, currentUrl: page && !page.isClosed() ? page.url() : null };
}

export async function launchSession(input: { testRunId: string; projectId: string; userId: string; browser: string; targetUrl: string; viewport: { width: number; height: number } }): Promise<SessionView> {
  if (!manualBrowserEnabled) throw new SessionError("MANUAL_BROWSER_DISABLED", sessionCapability().reason!, 409);
  const existing = live.get(input.testRunId);
  if (existing) throw new SessionError("SESSION_ALREADY_OPEN", "A testing window is already open for this run.");
  if (live.size >= config.MANUAL_SESSION_MAX_CONCURRENT) throw new SessionError("SESSION_LIMIT_REACHED", `At most ${config.MANUAL_SESSION_MAX_CONCURRENT} testing windows can be open at once. Close one first.`, 429);

  // The stored URL is re-checked here rather than trusted, exactly as the automated runner does.
  let target: string;
  try {
    target = await assertSafeUrl(input.targetUrl, undefined, { allowLocalFixture: config.EXECUTION_ALLOW_LOCAL_FIXTURE });
  } catch {
    throw new SessionError("DESTINATION_BLOCKED", "The application URL is not an allowed destination.", 400);
  }

  const row = await prisma.manualBrowserSession.create({ data: { testRunId: input.testRunId, projectId: input.projectId, startedById: input.userId, browser: input.browser, targetUrl: target, status: "STARTING" } });

  let browser: Browser;
  try {
    browser = await (browserTypes[input.browser] ?? chromium).launch({ headless: manualBrowserHeadless });
  } catch (error) {
    const message = /Executable doesn't exist|browserType\.launch/i.test(describe(error))
      ? `The ${input.browser} browser is not installed on the control-plane host. Run: npx playwright install ${input.browser}`
      : `The testing window could not be opened: ${describe(error)}`;
    await markEnded(row.id, "FAILED", "LAUNCH_FAILED", message);
    throw new SessionError("BROWSER_LAUNCH_FAILED", message, 503);
  }

  // A fresh context: no cookies, storage, or credentials shared with any other run or with the
  // automated runner. Whatever the tester signs in with lives and dies with this window.
  const context = await browser.newContext({ viewport: input.viewport });
  const session: LiveSession = { sessionId: row.id, testRunId: input.testRunId, browser, context, pages: [], idleTimer: null, closing: false };
  live.set(input.testRunId, session);

  browser.on("disconnected", () => {
    if (!session.closing) void teardown(session, "CRASHED", "BROWSER_DISCONNECTED", "The testing browser stopped unexpectedly. Launch a new window to continue.");
  });
  context.on("page", page => watchPage(session, page));

  try {
    await installGuard(context);
    const page = await context.newPage();
    await prisma.manualBrowserSession.update({ where: { id: row.id }, data: { status: "ACTIVE", lastActivityAt: new Date() } });
    resetIdle(session);
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (error) {
      // The window is open and usable; the first navigation failed. The tester can retry from the
      // address bar, so the session stays ACTIVE and the reason is shown rather than discarded.
      await prisma.manualBrowserSession.update({ where: { id: row.id }, data: { lastError: `Could not load the application: ${describe(error)}` } });
    }
  } catch (error) {
    await teardown(session, "CRASHED", "SETUP_FAILED", describe(error));
    throw new SessionError("SESSION_SETUP_FAILED", `The testing window could not be prepared: ${describe(error)}`, 503);
  }
  return (await getSession(input.testRunId))!;
}

export async function closeSession(testRunId: string, reason = "CLOSED_BY_TESTER"): Promise<boolean> {
  const session = live.get(testRunId);
  if (!session) {
    // Nothing alive here; make sure no row still claims otherwise.
    const { count } = await prisma.manualBrowserSession.updateMany({ where: { testRunId, status: { in: ["STARTING", "ACTIVE"] } }, data: { status: "CLOSED", endReason: reason, endedAt: new Date() } });
    return count > 0;
  }
  await teardown(session, "CLOSED", reason);
  return true;
}

/** Password, payment-card, and one-time-code fields are blacked out in every capture. */
const sensitiveSelectors = ['input[type="password"]', 'input[autocomplete^="cc-"]', 'input[autocomplete="one-time-code"]', 'input[name*="password" i]', 'input[name*="cvv" i]', 'input[name*="cvc" i]'];

/** Screenshot of what the tester currently sees in the testing window. */
export async function captureScreenshot(testRunId: string): Promise<{ body: Buffer; pageUrl: string }> {
  const session = live.get(testRunId);
  const page = session?.pages.filter(item => !item.isClosed()).at(-1);
  if (!session || !page) throw new SessionError("SESSION_NOT_ACTIVE", "No testing window is open for this run. Launch one, or upload a screenshot instead.");
  try {
    const body = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", timeout: 15_000, mask: sensitiveSelectors.map(selector => page.locator(selector)), maskColor: "#111c38" });
    await touch(session);
    return { body, pageUrl: page.url() };
  } catch (error) {
    throw new SessionError("CAPTURE_FAILED", `The screenshot could not be taken: ${describe(error)}`, 502);
  }
}

/** Closes every window this process opened. Called on shutdown so no browser outlives the server. */
export async function closeAllSessions(reason = "CONTROL_PLANE_STOPPED") {
  await Promise.all([...live.values()].map(session => teardown(session, "CLOSED", reason)));
}

/**
 * Called once when the control plane starts. Any session still marked open belonged to a process
 * that no longer exists, so its window is gone; the row is closed to match.
 */
export async function reconcileOrphanedSessions() {
  await prisma.manualBrowserSession.updateMany({ where: { status: { in: ["STARTING", "ACTIVE"] } }, data: { status: "CLOSED", endReason: "CONTROL_PLANE_RESTARTED", endedAt: new Date() } });
}

/** Test hook: how many windows this process holds. */
export const liveSessionCount = () => live.size;

/** Test hook: the open pages of a run's window, so a test can close one exactly as a tester would. */
export const livePagesForTest = (testRunId: string) => live.get(testRunId)?.pages ?? [];
