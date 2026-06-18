/**
 * Authenticated FB scraping client (browser-only, MISA-pattern).
 *
 * Uses the shared persistent context from src/fb/browser.ts so all flows
 * (login / discover / ETL) see the same fingerprint and FB keeps the session
 * trusted across server restarts.
 *
 * Flow per run:
 *   1. Open a page on the shared persistent context
 *   2. Navigate to facebook.com — wait for SPA to settle
 *   3. captureAuthContext() -> fb_dtsg, lsd, jazoest, spin_*
 *   4. Caller fires GraphQL calls via callGraphql() — replayed through XHR
 *      inside page.evaluate() to bypass any fetch hook (§6)
 */
import type { Page } from 'playwright';
import { openPage } from './browser.js';
import { loadActiveSession } from './session.js';
import { captureAuthContext, persistAuthContext, type AuthContext } from './auth.js';
import { callGraphql, type GraphqlCallArgs, type GraphqlResponse } from './graphql.js';
import { consumeBudget, randomDelayMs, sleep } from './budget.js';
import { pool } from '../db.js';

const FB_HOME = 'https://www.facebook.com/';

export class SessionWallError extends Error {}
export class AuthExpiredError extends Error {}

export interface FbClient {
  readonly cUser: string;
  readonly sessionId: number;
  /** Replay a GraphQL call. Consumes budget. Auto-refreshes auth on 1357004. */
  graphql(args: GraphqlCallArgs): Promise<GraphqlResponse>;
  /** Re-capture auth tokens (e.g. after long-running run) */
  refreshAuth(): Promise<AuthContext>;
  close(): Promise<void>;
}

class FbClientImpl implements FbClient {
  private auth!: AuthContext;
  private authContextId?: number;

  constructor(
    public readonly cUser: string,
    public readonly sessionId: number,
    private page: Page,
  ) {}

  static async create(): Promise<FbClientImpl> {
    const sess = await loadActiveSession();
    if (!sess) throw new Error('No active FB session — login via /api/login/* first');

    const page = await openPage();
    const resp = await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp) throw new Error('No response from fb home');
    const finalUrl = page.url();
    if (/\/login|\/checkpoint/.test(finalUrl)) {
      try { await page.close(); } catch {}
      throw new SessionWallError(`Hit ${finalUrl} — session expired, re-login required`);
    }

    // FB lazy-loads DTSGInitialData; wait until the token is in the DOM.
    await page.waitForFunction(
      () => {
        if (document.querySelector('input[name="fb_dtsg"]')) return true;
        for (const s of Array.from(document.querySelectorAll('script'))) {
          const t = s.textContent || '';
          if (t.includes('DTSGInitialData') || t.includes('"dtsg":{"token"')) return true;
        }
        return false;
      },
      { timeout: 30000 },
    ).catch(() => { /* captureAuthContext will throw a clear error if still missing */ });

    const client = new FbClientImpl(sess.c_user, sess.id, page);
    try {
      client.auth = await captureAuthContext(page);
    } catch (e) {
      const diag = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        bodyHead: (document.body?.innerText || '').slice(0, 200),
        hasLoginForm: !!document.querySelector('form[action*="login"]'),
        cookies: document.cookie.split('; ').map((c) => c.split('=')[0]).join(','),
      })).catch(() => null);
      try { await page.screenshot({ path: `data/log/auth-fail-${Date.now()}.png` }); } catch {}
      console.error('captureAuthContext failed — page diag:', JSON.stringify(diag));
      try { await page.close(); } catch {}
      if (diag?.hasLoginForm || !diag?.cookies?.includes('c_user')) {
        throw new SessionWallError(
          `Session revoked by FB (page=${diag?.url}, cookies=${diag?.cookies}). Re-login via /api/login/* required.`
        );
      }
      throw e;
    }
    client.authContextId = await persistAuthContext(sess.id, client.auth);
    return client;
  }

  async refreshAuth(): Promise<AuthContext> {
    await this.page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    this.auth = await captureAuthContext(this.page);
    this.authContextId = await persistAuthContext(this.sessionId, this.auth);
    return this.auth;
  }

  async graphql(args: GraphqlCallArgs): Promise<GraphqlResponse> {
    await consumeBudget(this.cUser);
    await sleep(randomDelayMs());
    let res = await callGraphql(this.page, this.auth, args);
    if (!res.ok && res.error && /1357004|Invalid form data|Please try closing/i.test(res.error)) {
      await this.refreshAuth();
      res = await callGraphql(this.page, this.auth, args);
    }
    if (!res.ok && res.status === 0 && res.error === 'network error') {
      await this.logFailure(args, res);
      throw new Error(`graphql network error for ${args.friendlyName}`);
    }
    if (!res.ok) {
      await this.logFailure(args, res);
      throw new Error(`graphql ${args.friendlyName} failed: HTTP ${res.status} ${res.error ?? ''}`);
    }
    return res;
  }

  private async logFailure(args: GraphqlCallArgs, res: GraphqlResponse) {
    try {
      await pool.query(
        `INSERT INTO xhr_capture
           (session_id, discover_run_id, method, url, friendly_name, doc_id, status, request_body, response_body, note)
         VALUES ($1,$2,'POST','/api/graphql/',$3,$4,$5,$6,$7,'replay-failure')`,
        [
          this.sessionId,
          `auth_ctx=${this.authContextId ?? ''}`,
          args.friendlyName,
          args.docId ?? null,
          res.status,
          JSON.stringify({ variables: args.variables }),
          res.rawText.slice(0, 200_000),
        ]
      );
    } catch {}
  }

  /** Only closes the per-run page; the shared browser context stays alive. */
  async close() {
    try { await this.page.close(); } catch {}
  }
}

export async function createFbClient(): Promise<FbClient> {
  return await FbClientImpl.create();
}
