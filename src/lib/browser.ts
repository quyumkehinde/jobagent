import { chromium, Browser } from "playwright-core";
import { UA } from "@/connectors/types";
import { createLogger } from "./log";

const log = createLogger("browser");

// Headless rendering for JS-only careers pages. Uses the machine's installed Chrome
// (no bundled-browser download). Lazy singleton per pipeline run; ALWAYS close via
// closeBrowser() in the pipeline's finally — the worker is long-lived.

const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RENDER_TIMEOUT_MS = 20_000;

let browser: Browser | null = null;
let unavailable = false;

async function getBrowser(): Promise<Browser | null> {
  if (browser?.isConnected()) return browser;
  if (unavailable) return null;
  for (const opts of [{ channel: "chrome" as const }, { executablePath: CHROME_MAC }]) {
    try {
      browser = await chromium.launch({ ...opts, headless: true });
      log.info("chrome launched", { via: "channel" in opts ? "channel" : "path" });
      return browser;
    } catch {
      // try next strategy
    }
  }
  unavailable = true;
  log.warn("no Chrome found — JS rendering disabled (install Google Chrome or run: npx playwright install chromium)");
  return null;
}

export async function renderingAvailable(): Promise<boolean> {
  return (await getBrowser()) !== null;
}

// Rendered HTML of the page, or null on any failure (callers treat null like a failed fetch).
export async function renderPage(url: string): Promise<string | null> {
  const b = await getBrowser();
  if (!b) return null;
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    context = await b.newContext({ userAgent: UA, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    // keep CSS (some frameworks gate rendering on it); drop heavy media
    await page.route("**/*", (route) =>
      ["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue()
    );
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {}); // busy pages never go idle — fine
    // one scroll pass: job lists routinely lazy-load below the fold
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(500);
    const html = await page.content();
    log.info("rendered", { url: url.slice(0, 80), bytes: html.length });
    return html;
  } catch (err) {
    log.warn("render failed", { url: url.slice(0, 80), error: String(err).slice(0, 150) });
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}

// A render fn that refuses (returns null) once its per-run budget is spent.
export function createRenderBudget(max: number): (url: string) => Promise<string | null> {
  let used = 0;
  return async (url: string) => {
    if (used >= max) return null;
    used++;
    return renderPage(url);
  };
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  unavailable = false; // re-probe next run — Chrome may have been (un)installed meanwhile
  if (b) await b.close().catch(() => {});
}
