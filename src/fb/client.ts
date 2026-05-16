/**
 * Authenticated FB scraping client (browser-only, MISA-pattern).
 *
 * Flow per run:
 *   1. Launch headed Chrome (Xvfb in prod, headless in dev) with saved storage_state
 *   2. Navigate to facebook.com — wait for SPA to settle
 *   3. captureAuthContext() -> fb_dtsg, lsd, jazoest, spin_*
 *   4. Caller fires GraphQL calls via callGraphql() — replayed through XHR
 *      inside page.evaluate() to bypass any fetch hook (§6)
 *
 * NO mbasic, NO axios direct calls. FB will reject anything that isn't
 * coming from a real browser session.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { loadActiveSession, type StorageState } from './session.js';
import { captureAuthContext, persistAuthContext, type AuthContext } from './auth.js';
import { callGraphql, type GraphqlCallArgs, type GraphqlResponse } from './graphql.js';
import { consumeBudget, randomDelayMs, sleep } from './budget.js';
import { pool } from '../db.js';

chromiumExtra.use(stealth());

const FB_HOME = 'https://www.facebook.com/';
const USER_AGENT_DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
    private browser: Browser,
    private context: BrowserContext,
    private page: Page,
  ) {}

  static async create(): Promise<FbClientImpl> {
    const sess = await loadActiveSession();
    if (!sess) throw new Error('No active FB session — login via /api/login/* first');

    const browser = await chromiumExtra.launch({
      headless: process.env.BROWSER_HEADLESS === 'true',
      executablePath: process.env.CHROME_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    const context = await browser.newContext({
      storageState: sess.storage_state as StorageState as any,
      userAgent: USER_AGENT_DESKTOP,
      viewport: { width: 1280, height: 900 },
      locale: 'vi-VN',
    });
    const page = await context.newPage();
    const resp = await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp) throw new Error('No response from fb home');
    const finalUrl = page.url();
    if (/\/login|\/checkpoint/.test(finalUrl)) {
      try { await context.close(); } catch {}
      try { await browser.close(); } catch {}
      throw new SessionWallError(`Hit ${finalUrl} — session expired, re-login required`);
    }

    const client = new FbClientImpl(sess.c_user, sess.id, browser, context, page);
    client.auth = await captureAuthContext(page);
    client.authContextId = await persistAuthContext(sess.id, client.auth);
    return client;
  }

  async refreshAuth(): Promise<AuthContext> {
    // Soft-reload to re-arm tokens without losing session
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
      // Stale fb_dtsg — refresh and retry once
      await this.refreshAuth();
      res = await callGraphql(this.page, this.auth, args);
    }
    if (!res.ok && res.status === 0 && res.error === 'network error') {
      // Could be a hard fetch-hook block. Log to xhr_capture for inspection.
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

  async close() {
    try { await this.context.close(); } catch {}
    try { await this.browser.close(); } catch {}
  }
}

export async function createFbClient(): Promise<FbClient> {
  return await FbClientImpl.create();
}
