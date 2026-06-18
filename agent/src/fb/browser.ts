/**
 * Persistent Chrome context for the agent — "lazy + headless" architecture.
 *
 * Profile at /var/lib/auto-facebook-agent/chrome-profile (writable by
 * auto-fb-agent system user). Two modes:
 *
 *   - 'crawl' (default, runs in main agent process): headless, smaller viewport,
 *     blocks images/fonts/media via route() to slash RAM ~30-50%. Context is
 *     OPENED at start of each ETL run and CLOSED at the end → 0 RAM between
 *     ticks (every 2h, agent is idle for ~115 min of each 120-min cycle).
 *
 *   - 'login' (runs in separate `auto-facebook-agent-login.service`): headed
 *     Chrome on DISPLAY=:202 so customer can SSH-tunnel + noVNC + login FB.
 *     This mode is opt-in — customer manually `systemctl start` when wanting
 *     to login.
 *
 * launchPersistentContext locks the profile dir, so only ONE mode can run at
 * a time. ETL runner checks for /var/lib/auto-facebook-agent/login.lock and
 * skips the crawl tick if login mode is active.
 */
import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';
import { mkdirSync } from 'node:fs';

chromiumExtra.use(stealth());

const USER_DATA_DIR = process.env.AGENT_CHROME_PROFILE || '/var/lib/auto-facebook-agent/chrome-profile';
const USER_AGENT_DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type BrowserMode = 'crawl' | 'login';

let ctxPromise: Promise<BrowserContext> | null = null;

async function buildContext(mode: BrowserMode): Promise<BrowserContext> {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const headless = mode === 'crawl';
  // Crawl mode uses smaller viewport — Chrome allocates layout/raster buffers
  // proportional to viewport size. 1280x800 vs 1920x1080 saves ~50-100MB.
  const viewport = headless ? { width: 1280, height: 800 } : { width: 1920, height: 1080 };

  const ctx = await chromiumExtra.launchPersistentContext(USER_DATA_DIR, {
    headless,
    executablePath: process.env.CHROME_PATH || undefined,
    userAgent:      USER_AGENT_DESKTOP,
    viewport,
    locale:         'vi-VN',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-position=0,0',
      `--window-size=${viewport.width},${viewport.height}`,
      // Memory-frugal flags (apply to both modes; especially important on headed):
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--js-flags=--max-old-space-size=512',
    ],
  });

  // tsx/esbuild emits __name(fn, "name") wrappers when serializing callbacks
  // for page.evaluate; polyfill inside every page in this context.
  await ctx.addInitScript(() => {
    // @ts-ignore
    if (typeof globalThis.__name !== 'function') globalThis.__name = (t: any) => t;
  });

  // Crawl mode: block heavy resources we don't need (we parse JSON, never
  // render pixels). FB still works because we keep scripts + stylesheets +
  // XHR/fetch alive. Cuts RAM ~30-40% on FB.
  if (mode === 'crawl') {
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'media') return route.abort();
      return route.continue();
    });
  }

  return ctx;
}

/** Get (or open) the persistent context. Default mode is 'crawl'. */
export function getBrowserContext(mode: BrowserMode = 'crawl'): Promise<BrowserContext> {
  if (!ctxPromise) ctxPromise = buildContext(mode);
  return ctxPromise;
}

/** Close the context completely — frees ALL Chrome RAM. Call after each ETL run. */
export async function closeBrowserContext(): Promise<void> {
  if (!ctxPromise) return;
  try {
    const ctx = await ctxPromise;
    await ctx.close();
  } catch {}
  ctxPromise = null;
}

export async function openPage(mode: BrowserMode = 'crawl'): Promise<Page> {
  const ctx = await getBrowserContext(mode);
  return await ctx.newPage();
}
