/**
 * Import cookies from Cookie-Editor JSON into the agent's persistent Chrome profile.
 *
 * Cookie-Editor exports an array of { name, value, domain, path, expirationDate,
 * hostOnly, httpOnly, secure, sameSite, session, storeId } objects. We map these
 * to Playwright's BrowserContext.addCookies() shape and write to the profile.
 *
 * Run via: tsx import-cookies.ts <path-to-cookies.json>
 */
import { readFileSync } from 'node:fs';
import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromiumExtra.use(stealth());

interface CookieEditorCookie {
  name:            string;
  value:           string;
  domain:          string;
  path:            string;
  expirationDate?: number;
  hostOnly?:       boolean;
  httpOnly?:       boolean;
  secure?:         boolean;
  sameSite?:       string;
  session?:        boolean;
}

interface PlaywrightCookie {
  name:     string;
  value:    string;
  domain:   string;
  path:     string;
  expires?: number;
  httpOnly?: boolean;
  secure?:  boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

function mapSameSite(s?: string): 'Strict' | 'Lax' | 'None' | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'lax' || v === 'unspecified' || v === 'no_restriction') return 'Lax';
  if (v === 'none') return 'None';
  return 'Lax';
}

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) { console.error('usage: import-cookies.ts <path>'); process.exit(1); }

  const raw = readFileSync(jsonPath, 'utf8');
  const rawCookies: CookieEditorCookie[] = JSON.parse(raw);
  if (!Array.isArray(rawCookies)) { console.error('json must be an array'); process.exit(1); }

  console.log(`[import-cookies] read ${rawCookies.length} cookies from ${jsonPath}`);

  // Filter to facebook.com domains only (defensive)
  const fbCookies = rawCookies.filter((c) =>
    typeof c.domain === 'string' && /facebook\.com|fbcdn\.net|messenger\.com/.test(c.domain)
  );
  console.log(`[import-cookies] ${fbCookies.length} match facebook domains`);

  // Map → Playwright shape
  const cookies: PlaywrightCookie[] = fbCookies.map((c) => {
    const out: PlaywrightCookie = {
      name:     c.name,
      value:    c.value,
      domain:   c.domain.startsWith('.') ? c.domain : '.' + c.domain.replace(/^\./, ''),
      path:     c.path || '/',
      httpOnly: c.httpOnly,
      secure:   c.secure,
      sameSite: mapSameSite(c.sameSite),
    };
    if (c.expirationDate && !c.session) out.expires = Math.floor(c.expirationDate);
    return out;
  });

  const profileDir = process.env.AGENT_CHROME_PROFILE || '/var/lib/auto-facebook-agent/chrome-profile';
  console.log(`[import-cookies] launching headless Chrome with profile=${profileDir}`);

  const ctx = await chromiumExtra.launchPersistentContext(profileDir, {
    headless:       true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    await ctx.addCookies(cookies);
    console.log(`[import-cookies] added ${cookies.length} cookies to profile`);

    // Verify c_user is present (FB user id) — confirms we have a real session.
    const all = await ctx.cookies('https://www.facebook.com/');
    const cUser = all.find((c) => c.name === 'c_user');
    if (cUser) {
      console.log(`[import-cookies] ✓ c_user cookie present (FB user id: ${cUser.value})`);
    } else {
      console.warn('[import-cookies] ⚠ no c_user cookie — agent will think profile is empty');
      console.warn('[import-cookies]   make sure you exported cookies while LOGGED IN to facebook.com');
    }
  } finally {
    await ctx.close();
  }

  console.log('[import-cookies] done — start the agent now');
}

main().catch((e) => { console.error(e); process.exit(1); });
