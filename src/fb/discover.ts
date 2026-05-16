/**
 * Discover mode: spawn a headed Chrome with the saved session, attach an
 * `request`/`response` listener that persists every FB API call to
 * `xhr_capture`. The user then browses through noVNC — opening a group,
 * scrolling the feed, expanding comments — and we log the GraphQL calls FB
 * fires so we can identify the right `friendly_name` / `doc_id` to replay.
 *
 * Workflow (SCRAPING_ARCHITECTURE.md §15.1 + §5):
 *   1. POST /api/discover/start          -> browser opens at facebook.com
 *   2. User opens noVNC, navigates to a target group, scrolls
 *   3. GET  /api/discover/captures       -> grouped list of XHRs seen
 *   4. User picks a `friendly_name` (e.g. GroupsCometFeedRegularStoriesPaginationQuery)
 *      and adds it to an EntityConfig
 *   5. POST /api/discover/stop           -> browser closes
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { pool } from '../db.js';
import { loadActiveSession } from './session.js';

chromiumExtra.use(stealth());

const FB_API_RE = /facebook\.com\/(api|ajax|webgraphql|graphql)/i;

export interface DiscoverHandle {
  runId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  sessionId: number;
  startedAt: Date;
  stop: () => Promise<void>;
}

let current: DiscoverHandle | null = null;

export function getDiscoverHandle(): DiscoverHandle | null {
  return current;
}

export async function startDiscover(opts?: { startUrl?: string; label?: string }): Promise<{ runId: string; sessionId: number }> {
  if (current) return { runId: current.runId, sessionId: current.sessionId };
  const sess = await loadActiveSession();
  if (!sess) throw new Error('No active session — /api/login/* first');

  const browser = await chromiumExtra.launch({
    headless: process.env.BROWSER_HEADLESS === 'true',
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: sess.storage_state as any,
    viewport: { width: 1280, height: 900 },
    locale: 'vi-VN',
  });
  const page = await context.newPage();

  const runId = opts?.label ?? `discover-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  context.on('response', async (resp) => {
    try {
      const req = resp.request();
      const url = req.url();
      if (!FB_API_RE.test(url)) return;
      const method = req.method();
      const reqBody = req.postData() ?? null;
      let respBody = '';
      try { respBody = (await resp.text()).slice(0, 200_000); } catch {}
      const headers = req.headers();
      const friendly = headers['x-fb-friendly-name'] || extractFromForm(reqBody, 'fb_api_req_friendly_name');
      const docId = extractFromForm(reqBody, 'doc_id');

      await pool.query(
        `INSERT INTO xhr_capture
           (session_id, discover_run_id, method, url, friendly_name, doc_id, status,
            request_headers, request_body, response_body, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sess.id, runId, method, url, friendly, docId, resp.status(), headers, reqBody, respBody, 'discover']
      );
    } catch {
      // never let capture failures break browsing
    }
  });

  await page.goto(opts?.startUrl ?? 'https://www.facebook.com/groups/feed/').catch(() => {});

  current = {
    runId,
    browser,
    context,
    page,
    sessionId: sess.id,
    startedAt: new Date(),
    stop: async () => {
      try { await context.close(); } catch {}
      try { await browser.close(); } catch {}
      current = null;
    },
  };
  return { runId, sessionId: sess.id };
}

export async function stopDiscover(): Promise<{ ok: true }> {
  if (current) await current.stop();
  return { ok: true };
}

function extractFromForm(body: string | null | undefined, key: string): string | null {
  if (!body) return null;
  try {
    const params = new URLSearchParams(body);
    return params.get(key);
  } catch {
    return null;
  }
}

/**
 * Aggregate captured XHRs into a friendly list of (friendly_name, sample_count).
 * Helps user spot interesting endpoints.
 */
export async function listCaptureSummary(runId?: string) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(friendly_name, '(none)') AS friendly_name,
       count(*) AS n,
       max(captured_at) AS last_seen,
       (array_agg(id ORDER BY captured_at DESC))[1] AS sample_id
     FROM xhr_capture
     WHERE ($1::text IS NULL OR discover_run_id = $1)
       AND note = 'discover'
     GROUP BY friendly_name
     ORDER BY n DESC`,
    [runId ?? null]
  );
  return rows;
}

export async function getCapture(id: number) {
  const { rows } = await pool.query('SELECT * FROM xhr_capture WHERE id = $1', [id]);
  return rows[0] ?? null;
}
