/**
 * Replay FB GraphQL POST /api/graphql/ via page.evaluate(XMLHttpRequest).
 *
 * Why XHR instead of fetch (see SCRAPING_ARCHITECTURE.md §6):
 *   FB hooks window.fetch in some contexts to throw on non-SPA calls.
 *   XHR is the safer primitive — modern anti-bot code rarely re-hooks it.
 *
 * FB GraphQL responses are sometimes streamed NDJSON (one JSON object per line)
 * for live data; sometimes a single JSON. We parse both shapes.
 */
import type { Page } from 'playwright';
import type { AuthContext } from './auth.js';

export interface GraphqlCallArgs {
  friendlyName: string;            // e.g. 'GroupsCometFeedRegularStoriesPaginationQuery'
  docId?: string;                  // FB persisted query id (preferred)
  query?: string;                  // raw GraphQL (legacy; rare)
  variables: Record<string, unknown>;
  /** Override fb_api_caller_class (optional, FB sometimes filters by it) */
  callerClass?: string;
}

export interface GraphqlResponse {
  ok: boolean;
  status: number;
  rawText: string;
  payloads: any[];                 // parsed top-level objects (NDJSON-aware)
  error?: string;
  partialError?: string;           // non-fatal field-level FB error (data still usable)
}

export async function callGraphql(page: Page, auth: AuthContext, args: GraphqlCallArgs): Promise<GraphqlResponse> {
  const result = await pageEvaluateWithRetry(page, async (a) => {
    return await new Promise<GraphqlResponse>((resolve) => {
      const form = new URLSearchParams();
      form.set('fb_dtsg', a.auth.fb_dtsg);
      if (a.auth.lsd) form.set('lsd', a.auth.lsd);
      if (a.auth.jazoest) form.set('jazoest', a.auth.jazoest);
      form.set('fb_api_caller_class', a.callerClass ?? 'RelayModern');
      form.set('fb_api_req_friendly_name', a.friendlyName);
      form.set('variables', JSON.stringify(a.variables));
      form.set('server_timestamps', 'true');
      if (a.docId) form.set('doc_id', a.docId);
      if (a.query) form.set('q', a.query);
      if (a.auth.spin_r) form.set('__spin_r', a.auth.spin_r);
      if (a.auth.spin_t) form.set('__spin_t', a.auth.spin_t);
      if (a.auth.hsi) form.set('__hsi', a.auth.hsi);
      if (a.auth.rev) form.set('__rev', a.auth.rev);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/graphql/', true);
      xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('x-fb-friendly-name', a.friendlyName);
      if (a.auth.lsd) xhr.setRequestHeader('x-fb-lsd', a.auth.lsd);
      xhr.timeout = 120000;
      xhr.onload = () => {
        const txt = xhr.responseText;
        const payloads: any[] = [];
        // Try NDJSON first
        const lines = txt.split('\n').filter((l) => l.trim().length > 0);
        let allParsed = true;
        for (const ln of lines) {
          try { payloads.push(JSON.parse(ln)); } catch { allParsed = false; break; }
        }
        if (!allParsed) {
          payloads.length = 0;
          try { payloads.push(JSON.parse(txt)); } catch {}
        }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, rawText: txt, payloads });
      };
      xhr.onerror = () => resolve({ ok: false, status: 0, rawText: '', payloads: [], error: 'network error' });
      xhr.ontimeout = () => resolve({ ok: false, status: 0, rawText: '', payloads: [], error: 'timeout' });
      xhr.send(form.toString());
    });
  }, { auth, ...args });

  // Detect FB-level errors hidden in HTTP 200.
  // Distinguish FATAL (request-level: bad token, rate limit, query rejected →
  // no data) from PARTIAL field errors. FB increasingly returns the full feed
  // `data` alongside a `field_exception` on a deep optional field (e.g.
  // `associated_group/feature_intervention`); those must NOT discard the posts.
  if (result.ok) {
    const hasData = result.payloads.some(
      (p) => p?.data && typeof p.data === 'object' && Object.keys(p.data).length > 0
    );
    for (const p of result.payloads) {
      // Top-level singular `error` (e.g. {code:1357004} invalid token) is always
      // request-level → fatal (client.ts refreshes auth on this).
      if (p?.error) {
        result.ok = false;
        result.error = `FB error: ${JSON.stringify(p.error).slice(0, 500)}`;
        break;
      }
      const errs = p?.errors;
      if (Array.isArray(errs) && errs.length) {
        // Field-level partial errors carry a `path` and arrive with usable data —
        // tolerate (feed edges still present). Only fail when no data anywhere.
        const fieldLevel = errs.every((e: any) => Array.isArray(e?.path) && e.path.length > 0);
        if (fieldLevel && hasData) {
          result.partialError = `FB partial: ${JSON.stringify(errs[0]).slice(0, 300)}`;
          continue;
        }
        result.ok = false;
        result.error = `FB error: ${JSON.stringify(errs[0]).slice(0, 500)}`;
        break;
      }
    }
  }
  return result;
}

/**
 * Retry page.evaluate on "Execution context was destroyed" (SPA navigation race),
 * as per SCRAPING_ARCHITECTURE.md §6.
 */
async function pageEvaluateWithRetry<T, A>(page: Page, fn: (a: A) => Promise<T>, arg: A, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // Cast: Playwright's PageFunction generic (Unboxed<A>) doesn't unify with our
      // plain (a: A) signature; the call is correct at runtime (serialized + arg passed).
      return await page.evaluate(fn as any, arg as any);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      if (!/Execution context was destroyed|frame.*detached/i.test(msg)) throw e;
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
