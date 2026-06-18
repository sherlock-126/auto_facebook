/**
 * Single long-lived browser context backed by a persistent on-disk profile.
 *
 * Why: FB ties session validity to a stable browser fingerprint
 * (IndexedDB / LocalStorage / service-worker state / GPU & canvas cache).
 * If we launch a fresh `--user-data-dir=/tmp/...` each time and load cookies
 * via storageState, FB sees "valid cookies on a brand-new device" and
 * silently revokes the session within seconds.
 *
 * One persistent profile, owned for the lifetime of the server process,
 * keeps FB happy. All flows (login / discover / ETL) get pages from it.
 */
import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

chromiumExtra.use(stealth());

const USER_DATA_DIR = path.resolve(process.cwd(), 'data', 'chrome-profile');
const USER_AGENT_DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let ctxPromise: Promise<BrowserContext> | null = null;

async function buildContext(): Promise<BrowserContext> {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  // FB pins a logged-in session to its login IP. This host sits behind a NAT
  // that round-robins outbound across multiple public IPs, so FB sees the same
  // session hop between IPs → "automated behavior" warning → session revoked.
  // Route ALL Chrome traffic through one stable IP via a proxy to fix this.
  // Set FB_PROXY_SERVER (e.g. http://host:port or socks5://host:port);
  // optionally FB_PROXY_USERNAME / FB_PROXY_PASSWORD. No-op if unset.
  const proxyServer = process.env.FB_PROXY_SERVER?.trim();
  const proxy = proxyServer
    ? {
        server: proxyServer,
        username: process.env.FB_PROXY_USERNAME || undefined,
        password: process.env.FB_PROXY_PASSWORD || undefined,
      }
    : undefined;
  if (proxy) console.log(`[browser] routing Chrome via proxy ${proxyServer}`);
  const ctx = await chromiumExtra.launchPersistentContext(USER_DATA_DIR, {
    headless: process.env.BROWSER_HEADLESS === 'true',
    executablePath: process.env.CHROME_PATH || undefined,
    userAgent: USER_AGENT_DESKTOP,
    viewport: { width: 1920, height: 1080 },
    locale: 'vi-VN',
    proxy,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-position=0,0',
      '--window-size=1920,1080',
    ],
  });
  // tsx/esbuild emits __name(fn, "name") wrappers when serializing the
  // callback for page.evaluate; polyfill it inside every page in this context.
  await ctx.addInitScript(() => {
    // @ts-ignore
    if (typeof globalThis.__name !== 'function') globalThis.__name = (t: any) => t;
  });
  console.log(`[browser] persistent context ready (profile=${USER_DATA_DIR}, cookies=${(await ctx.cookies()).length})`);
  return ctx;
}

export function getBrowserContext(): Promise<BrowserContext> {
  if (!ctxPromise) ctxPromise = buildContext();
  return ctxPromise;
}

export async function closeBrowserContext(): Promise<void> {
  if (!ctxPromise) return;
  try {
    const ctx = await ctxPromise;
    await ctx.close();
  } catch {}
  ctxPromise = null;
}

/** Open a page (caller responsible for closing). */
export async function openPage(): Promise<Page> {
  const ctx = await getBrowserContext();
  return await ctx.newPage();
}
