/**
 * Authenticated FB scraping client for the agent.
 *
 * Differences from cloud's src/fb/client.ts:
 *   - No DB session — the persistent Chrome profile IS the session
 *   - On `SessionWallError`, logs SSH-tunnel instructions for the customer
 *   - On graphql failure, logs to journal (no xhr_capture table on agent)
 */
import type { Page } from 'playwright';
import { openPage } from './browser.js';
import { getCUser } from './session.js';
import { captureAuthContext, type AuthContext } from './auth.js';
import { callGraphql, type GraphqlCallArgs, type GraphqlResponse } from './graphql.js';
import { consumeBudget, randomDelayMs, sleep } from './budget.js';
import { log } from '../log.js';

const FB_HOME = 'https://www.facebook.com/';

export class SessionWallError extends Error {}

export interface FbClient {
  readonly cUser: string;
  graphql(args: GraphqlCallArgs): Promise<GraphqlResponse>;
  refreshAuth(): Promise<AuthContext>;
  close(): Promise<void>;
}

class FbClientImpl implements FbClient {
  private auth!: AuthContext;
  constructor(public readonly cUser: string, private page: Page) {}

  static async create(): Promise<FbClientImpl> {
    const cUser = await getCUser();
    if (!cUser) {
      throw new SessionWallError(
        'No Facebook session in chrome-profile. Customer must SSH-tunnel + login via noVNC. ' +
        'See: ssh -L 6092:127.0.0.1:6092 root@<vps-ip>'
      );
    }

    const page = await openPage();
    const resp = await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!resp) throw new Error('No response from fb home');
    const finalUrl = page.url();
    if (/\/login|\/checkpoint/.test(finalUrl)) {
      try { await page.close(); } catch {}
      throw new SessionWallError(
        `Hit ${finalUrl} — session expired or checkpoint, customer must SSH-tunnel + re-login via noVNC`
      );
    }

    await page.waitForFunction(
      () => {
        if (document.querySelector('input[name="fb_dtsg"]')) return true;
        for (const s of Array.from(document.querySelectorAll('script'))) {
          const t = s.textContent || '';
          if (t.includes('DTSGInitialData') || t.includes('"dtsg":{"token"')) return true;
        }
        return false;
      },
      { timeout: 30_000 },
    ).catch(() => { /* captureAuthContext will throw a clear error */ });

    const client = new FbClientImpl(cUser, page);
    try {
      client.auth = await captureAuthContext(page);
    } catch (e: any) {
      const diag = await page.evaluate(() => ({
        url:    location.href,
        title:  document.title,
        bodyHead:    (document.body?.innerText || '').slice(0, 200),
        hasLoginForm: !!document.querySelector('form[action*="login"]'),
        cookies:     document.cookie.split('; ').map((c) => c.split('=')[0]).join(','),
      })).catch(() => null);
      try { await page.close(); } catch {}
      log('error', 'captureAuthContext failed', { diag, err: e?.message });
      if (diag?.hasLoginForm || !diag?.cookies?.includes('c_user')) {
        throw new SessionWallError(
          `Session revoked by FB (page=${diag?.url}). Customer must SSH-tunnel + re-login via noVNC`
        );
      }
      throw e;
    }
    return client;
  }

  async refreshAuth(): Promise<AuthContext> {
    await this.page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    this.auth = await captureAuthContext(this.page);
    return this.auth;
  }

  async graphql(args: GraphqlCallArgs): Promise<GraphqlResponse> {
    consumeBudget(this.cUser);
    await sleep(randomDelayMs());
    let res = await callGraphql(this.page, this.auth, args);
    if (!res.ok && res.error && /1357004|Invalid form data|Please try closing/i.test(res.error)) {
      await this.refreshAuth();
      res = await callGraphql(this.page, this.auth, args);
    }
    if (!res.ok) {
      log('error', `graphql ${args.friendlyName} failed`, { status: res.status, error: res.error, raw: res.rawText.slice(0, 300) });
      throw new Error(`graphql ${args.friendlyName} failed: HTTP ${res.status} ${res.error ?? ''}`);
    }
    return res;
  }

  async close() {
    try { await this.page.close(); } catch {}
  }
}

export async function createFbClient(): Promise<FbClient> {
  return await FbClientImpl.create();
}
