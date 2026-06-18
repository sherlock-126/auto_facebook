/**
 * Agent doesn't store session in a DB — the persistent Chrome profile IS the
 * session (cookies live in /var/lib/auto-facebook-agent/chrome-profile).
 */
import type { BrowserContext } from 'playwright';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getBrowserContext } from './browser.js';

const USER_DATA_DIR = process.env.AGENT_CHROME_PROFILE || '/var/lib/auto-facebook-agent/chrome-profile';

/**
 * Cheap pure-filesystem heuristic: do we have a populated cookies DB?
 *
 * A fresh Chrome profile has no `Default/Cookies` file. After Chrome ran once
 * and the user logged into Facebook, the file exists and grows to >5KB.
 * We use this BEFORE launching Chrome (which on low-RAM VPS can OOM) to skip
 * the entire crawl when there's clearly no session.
 *
 * False positive: customer opened Chrome but never logged into Facebook → file
 * exists but no FB cookie. Then Chrome launches, hits SessionWallError, exits.
 * That's the same as today — not worse.
 */
export function profileLooksLoggedIn(): boolean {
  try {
    const cookiesPath = join(USER_DATA_DIR, 'Default', 'Cookies');
    const st = statSync(cookiesPath);
    return st.size > 5 * 1024;
  } catch {
    return false;
  }
}

/** Returns the FB user ID (c_user cookie) if logged in, else null. Launches Chrome. */
export async function getCUser(ctx?: BrowserContext): Promise<string | null> {
  const context = ctx ?? (await getBrowserContext());
  const cookies = await context.cookies('https://www.facebook.com/');
  return cookies.find((c) => c.name === 'c_user')?.value ?? null;
}
