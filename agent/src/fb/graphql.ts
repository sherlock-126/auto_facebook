/**
 * Replay FB GraphQL POST /api/graphql/ via page.evaluate(XMLHttpRequest).
 * 1:1 port from cloud's src/fb/graphql.ts (no changes — pure browser logic).
 */
import type { Page } from 'playwright';
import type { AuthContext } from './auth.js';

export interface GraphqlCallArgs {
  friendlyName: string;
  docId?:       string;
  query?:       string;
  variables:    Record<string, unknown>;
  callerClass?: string;
}

export interface GraphqlResponse {
  ok:       boolean;
  status:   number;
  rawText:  string;
  payloads: any[];
  error?:   string;
}

export async function callGraphql(page: Page, auth: AuthContext, args: GraphqlCallArgs): Promise<GraphqlResponse> {
  const result = await pageEvaluateWithRetry(page, async (a: any) => {
    return await new Promise<GraphqlResponse>((resolve) => {
      const form = new URLSearchParams();
      form.set('fb_dtsg', a.auth.fb_dtsg);
      if (a.auth.lsd)     form.set('lsd', a.auth.lsd);
      if (a.auth.jazoest) form.set('jazoest', a.auth.jazoest);
      form.set('fb_api_caller_class', a.callerClass ?? 'RelayModern');
      form.set('fb_api_req_friendly_name', a.friendlyName);
      form.set('variables', JSON.stringify(a.variables));
      form.set('server_timestamps', 'true');
      if (a.docId) form.set('doc_id', a.docId);
      if (a.query) form.set('q', a.query);
      if (a.auth.spin_r) form.set('__spin_r', a.auth.spin_r);
      if (a.auth.spin_t) form.set('__spin_t', a.auth.spin_t);
      if (a.auth.hsi)    form.set('__hsi', a.auth.hsi);
      if (a.auth.rev)    form.set('__rev', a.auth.rev);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/graphql/', true);
      xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('x-fb-friendly-name', a.friendlyName);
      if (a.auth.lsd) xhr.setRequestHeader('x-fb-lsd', a.auth.lsd);
      xhr.timeout = 120000;
      xhr.onload = () => {
        const txt = xhr.responseText;
        const payloads: any[] = [];
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
      xhr.onerror   = () => resolve({ ok: false, status: 0, rawText: '', payloads: [], error: 'network error' });
      xhr.ontimeout = () => resolve({ ok: false, status: 0, rawText: '', payloads: [], error: 'timeout' });
      xhr.send(form.toString());
    });
  }, { auth, ...args } as any);

  if (result.ok) {
    for (const p of result.payloads) {
      const err = p?.error || p?.errors?.[0];
      if (err) {
        result.ok = false;
        result.error = `FB error: ${JSON.stringify(err).slice(0, 500)}`;
        break;
      }
    }
  }
  return result;
}

async function pageEvaluateWithRetry<T>(page: Page, fn: (a: any) => Promise<T>, arg: any, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.evaluate(fn, arg);
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
