import type { Job } from "bullmq";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType } from "playwright";
import { config } from "../config";
import { prisma } from "../db";
import { assertSafeUrl, normalizeUrl } from "./scope";
import { describeDiscoveryFailure } from "./failures";
import type { DiscoveryJobData } from "./queue";

const browserTypes: Record<DiscoveryJobData["browser"], BrowserType> = { chromium, firefox, webkit };
const short = (value: string | null | undefined, limit: number) => value?.slice(0, limit) ?? null;

export async function runDiscovery(data: DiscoveryJobData, job: Job<DiscoveryJobData>) {
  const maxEndpoints = config.DISCOVERY_MAX_ENDPOINTS;
  const startedAt = new Date();
  let origin = data.applicationUrl;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    origin = await assertSafeUrl(data.applicationUrl, undefined, { allowLocalFixture: data.allowLocalFixture });
    await prisma.discoveryRun.update({ where: { id: data.discoveryRunId }, data: { status: "DISCOVERING", startedAt } });
    try { browser = await browserTypes[data.browser].launch({ headless: true }); } catch { throw new Error("BROWSER_LAUNCH_FAILED"); }
    context = await browser.newContext({ viewport: data.viewport });
    const queue = [{ url: origin, depth: 0, parentUrl: null as string | null }];
    const visited = new Set<string>();
    while (queue.length && visited.size < data.maxPages && Date.now() - startedAt.getTime() < data.maxDurationSeconds * 1000) {
      const current = await prisma.discoveryRun.findUnique({ where: { id: data.discoveryRunId }, select: { cancelRequestedAt: true } });
      if (current?.cancelRequestedAt) throw new Error("CANCELLED");
      const item = queue.shift()!;
      const normalized = await assertSafeUrl(item.url, origin, { allowLocalFixture: data.allowLocalFixture });
      if (visited.has(normalized) || item.depth > data.maxDepth) continue;
      visited.add(normalized);
      const page = await context.newPage();
      let redirectCount = 0;
      let blockedReason: string | undefined;
      let blockedSubresources = 0;
      const blockedOrigins = new Set<string>();
      await page.route("**/*", async route => {
        const request = route.request();
        // Only the document this crawl is actually visiting can fail the crawl. A page's own
        // subresources are a different matter: essentially every real site loads fonts, scripts, or
        // images from a CDN, and those are cross-origin by definition. Aborting them is the egress
        // policy working as intended - treating them as fatal made the crawler unable to visit any
        // real website, which is exactly what happened on the first external URL it was pointed at.
        const isDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
        try {
          await assertSafeUrl(request.url(), origin, { allowLocalFixture: data.allowLocalFixture });
          if (request.redirectedFrom()) {
            redirectCount += 1;
            if (redirectCount > data.maxRedirects) throw new Error("TOO_MANY_REDIRECTS");
          }
          await route.continue();
        } catch (error) {
          const reason = error instanceof Error ? error.message : "REQUEST_BLOCKED";
          if (isDocument) blockedReason = reason;
          else {
            blockedSubresources += 1;
            try { blockedOrigins.add(new URL(request.url()).origin); } catch { /* unparseable target */ }
          }
          // The request never leaves the machine either way, so the SSRF and egress guarantees hold.
          await route.abort("blockedbyclient");
        }
      });
      // Endpoints the page called on its own. Observation only: the crawler records what the
      // application already did and never issues a request of its own, so building this inventory
      // cannot create, modify, or delete anything.
      const observedEndpoints = new Map<string, { method: string; url: string; normalizedUrl: string; resourceType: string; observedStatus: number | null; contentType: string | null; observationCount: number }>();
      page.on("response", response => {
        const contentLength = Number(response.headers()["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > data.maxResponseBytes) blockedReason = "RESPONSE_TOO_LARGE";

        const request = response.request();
        const resourceType = request.resourceType();
        if (resourceType !== "xhr" && resourceType !== "fetch") return;
        if (observedEndpoints.size >= maxEndpoints) return;
        try {
          const parsed = new URL(request.url());
          if (parsed.origin !== new URL(origin).origin) return;
          // Keyed by path with the query dropped, so a paginated list is one endpoint rather than
          // one per page number. The full URL is kept separately as something real to replay.
          const normalizedUrl = `${parsed.origin}${parsed.pathname}`;
          const key = `${request.method()} ${normalizedUrl}`;
          const existing = observedEndpoints.get(key);
          if (existing) {
            existing.observationCount += 1;
            return;
          }
          observedEndpoints.set(key, {
            method: request.method().slice(0, 10),
            url: request.url().slice(0, 2_000),
            normalizedUrl: normalizedUrl.slice(0, 2_000),
            resourceType,
            observedStatus: response.status(),
            contentType: short(response.headers()["content-type"], 200) ?? null,
            observationCount: 1,
          });
        } catch {
          /* an unparseable request URL is not inventory */
        }
      });
      const navigationStarted = Date.now();
      try {
        const response = await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: data.maxDurationSeconds * 1000 });
        if (blockedReason) throw new Error(blockedReason);
        const finalUrl = await assertSafeUrl(page.url(), origin, { allowLocalFixture: data.allowLocalFixture });
        // Two queued URLs can redirect to the same destination - canonical redirects make this
        // ordinary on real sites - and the page row is keyed by the URL actually landed on. The
        // queue is deduplicated on the URL requested, so without this the second arrival violates
        // the unique constraint and takes the whole crawl down with it.
        if (finalUrl !== normalized && visited.has(finalUrl)) continue;
        visited.add(finalUrl);
        if (response && (await response.body()).byteLength > data.maxResponseBytes) throw new Error("RESPONSE_TOO_LARGE");
        const pageRecord = await prisma.discoveredPage.create({ data: { discoveryRunId: data.discoveryRunId, url: page.url(), normalizedUrl: finalUrl, title: (await page.title()).slice(0, 500), httpStatus: response?.status(), depth: item.depth, parentUrl: item.parentUrl, contentType: short(response?.headers()["content-type"], 200), loadDurationMs: Date.now() - navigationStarted, viewport: data.viewport, browser: data.browser, textSummary: (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 2_000) } });
        if (blockedSubresources > 0) {
          // Worth recording: it explains why a crawled page may look unstyled in a screenshot.
          console.log(JSON.stringify({ event: "discovery.subresources_blocked", discoveryRunId: data.discoveryRunId, url: finalUrl, blocked: blockedSubresources, origins: [...blockedOrigins].slice(0, 8) }));
        }

        const links = await page.locator("a[href]").evaluateAll(anchors => anchors.map(anchor => ({ href: (anchor as HTMLAnchorElement).href, text: (anchor.textContent ?? "").trim().slice(0, 500) })));
        for (const link of links) {
          let linkUrl: string | null = null;
          try { linkUrl = normalizeUrl(link.href, finalUrl, { allowLocalFixture: data.allowLocalFixture }); } catch { /* untrusted or unsupported link */ }
          const sameOrigin = linkUrl ? new URL(linkUrl).origin === new URL(origin).origin : false;
          await prisma.discoveredLink.create({ data: { discoveryRunId: data.discoveryRunId, pageId: pageRecord.id, href: link.href.slice(0, 2_000), normalizedUrl: linkUrl, visibleText: link.text, sameOrigin } }).catch(() => undefined);
          if (sameOrigin && linkUrl && !visited.has(linkUrl)) queue.push({ url: linkUrl, depth: item.depth + 1, parentUrl: finalUrl });
        }
        const forms = await page.locator("form").evaluateAll(items => items.map(form => ({ identifier: form.id || form.getAttribute("name") || "", action: (form as HTMLFormElement).action, method: (form as HTMLFormElement).method || "get", enctype: (form as HTMLFormElement).enctype || "", fields: Array.from(form.querySelectorAll("input,select,textarea")).map(field => { const id = field.id; const associated = id ? form.querySelector(`label[for="${CSS.escape(id)}"]`) : field.closest("label"); const label = associated?.textContent?.trim() || null; const accessibleName = field.getAttribute("aria-label") || label; return { name: field.getAttribute("name") || "", type: field.getAttribute("type") || field.tagName.toLowerCase(), inputMode: field.getAttribute("inputmode"), placeholder: field.getAttribute("placeholder"), label: accessibleName, required: field.hasAttribute("required"), autocomplete: field.getAttribute("autocomplete"), selectorCandidates: [field.getAttribute("data-testid") ? `[data-testid="${field.getAttribute("data-testid")}"]` : null, id ? `#${id}` : null, field.getAttribute("name") ? `[name="${field.getAttribute("name")}"]` : null].filter(Boolean) }; }) })));
        for (const form of forms) await prisma.discoveredForm.create({ data: { discoveryRunId: data.discoveryRunId, pageId: pageRecord.id, identifier: form.identifier.slice(0, 200), action: form.action.slice(0, 2_000), method: form.method.slice(0, 20), enctype: form.enctype.slice(0, 100), fieldCount: form.fields.length, fields: { create: form.fields.map(field => ({ name: field.name.slice(0, 200), type: field.type.slice(0, 50), inputMode: field.inputMode, placeholder: field.placeholder?.slice(0, 500), label: field.label?.slice(0, 500), required: field.required, autocomplete: field.autocomplete, selectorCandidates: field.selectorCandidates })) } } });
        const elements = await page.locator("button, input, select, textarea, [role]").evaluateAll(items => items.map(element => { const id = element.id; const label = id ? element.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : element.closest("label")?.textContent?.trim(); const ariaLabel = element.getAttribute("aria-label"); return { tagName: element.tagName.toLowerCase(), role: element.getAttribute("role") || (element.tagName === "BUTTON" ? "button" : null), accessibleName: (ariaLabel || label || element.textContent || "").trim().slice(0, 500), ariaLabel, ariaLabelledBy: element.getAttribute("aria-labelledby"), ariaDescribedBy: element.getAttribute("aria-describedby"), selectorCandidates: [element.getAttribute("data-testid") ? `[data-testid="${element.getAttribute("data-testid")}"]` : null, id ? `#${id}` : null, element.getAttribute("name") ? `[name="${element.getAttribute("name")}"]` : null].filter(Boolean) }; }));
        if (elements.length) await prisma.discoveredElement.createMany({ data: elements.map(element => ({ discoveryRunId: data.discoveryRunId, pageId: pageRecord.id, ...element })) });
        // Upserted because two pages legitimately call the same endpoint; the observation count
        // rises rather than the crawl failing on a unique constraint.
        let newEndpoints = 0;
        for (const endpoint of observedEndpoints.values()) {
          const result = await prisma.discoveredEndpoint
            .upsert({
              where: { discoveryRunId_method_normalizedUrl: { discoveryRunId: data.discoveryRunId, method: endpoint.method, normalizedUrl: endpoint.normalizedUrl } },
              update: { observationCount: { increment: endpoint.observationCount } },
              create: { discoveryRunId: data.discoveryRunId, pageId: pageRecord.id, ...endpoint },
            })
            .catch(() => null);
          if (result && result.pageId === pageRecord.id && result.observationCount === endpoint.observationCount) newEndpoints += 1;
        }
        await prisma.discoveryRun.update({ where: { id: data.discoveryRunId }, data: { pagesDiscovered: visited.size, linksDiscovered: { increment: links.length }, formsDiscovered: { increment: forms.length }, elementsDiscovered: { increment: elements.length }, endpointsDiscovered: { increment: newEndpoints } } });
        await job.updateProgress({ pages: visited.size, queued: queue.length });
      } catch (error) {
        if (error instanceof Error && ["RESPONSE_TOO_LARGE", "TOO_MANY_REDIRECTS"].includes(error.message)) throw error;
        throw error;
      } finally { await page.close(); }
    }
    await prisma.discoveryRun.update({ where: { id: data.discoveryRunId }, data: { status: "COMPLETED", completedAt: new Date() } });
  } catch (error) {
    const cancelled = error instanceof Error && error.message === "CANCELLED";
    const message = error instanceof Error ? error.message : "Discovery failed";
    const safeMessage = describeDiscoveryFailure(message);
    await prisma.discoveryRun.update({ where: { id: data.discoveryRunId }, data: { status: cancelled ? "CANCELLED" : "FAILED", completedAt: new Date(), failureCode: cancelled ? "CANCELLED" : ["RESPONSE_TOO_LARGE", "TOO_MANY_REDIRECTS", "DESTINATION_BLOCKED", "CROSS_ORIGIN_BLOCKED", "BROWSER_LAUNCH_FAILED"].includes(message) ? message : "CRAWL_FAILED", failureMessage: safeMessage } }).catch(() => undefined);
    if (!cancelled) throw error;
  } finally { await context?.close(); await browser?.close(); }
}
