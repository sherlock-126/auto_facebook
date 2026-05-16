/**
 * Extract FB CSRF / session tokens from a logged-in page.
 *
 * FB embeds these in several places — we try each and merge.
 * Tokens rotate (esp. fb_dtsg every few hours). If a replay call returns
 * `errorCode: 1357004` ("Invalid form data"), call captureAuthContext again.
 */
import type { Page } from 'playwright';
import { pool } from '../db.js';

export interface AuthContext {
  fb_dtsg: string;
  lsd?: string;
  jazoest?: string;
  spin_r?: string;
  spin_t?: string;
  hsi?: string;
  rev?: string;
  c_user?: string;
}

export async function captureAuthContext(page: Page): Promise<AuthContext> {
  const ctx = await page.evaluate(() => {
    function getInput(name: string): string | undefined {
      const el = document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
      return el?.value || undefined;
    }
    function getCookie(name: string): string | undefined {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : undefined;
    }

    // 1. Hidden form inputs (most reliable)
    let fb_dtsg = getInput('fb_dtsg');
    let lsd = getInput('lsd');
    let jazoest = getInput('jazoest');

    // 2. Script body — FB embeds DTSGInitialData / DTSGInitData
    if (!fb_dtsg || !lsd) {
      const scripts = Array.from(document.querySelectorAll('script')).map((s) => s.textContent ?? '');
      for (const s of scripts) {
        if (!fb_dtsg) {
          const m = s.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)
                || s.match(/"dtsg":\{"token":"([^"]+)"/)
                || s.match(/name=\\"fb_dtsg\\" value=\\"([^\\"]+)\\"/);
          if (m) fb_dtsg = m[1];
        }
        if (!lsd) {
          const m = s.match(/"LSD",\[\],\{"token":"([^"]+)"/)
                || s.match(/name=\\"lsd\\" value=\\"([^\\"]+)\\"/);
          if (m) lsd = m[1];
        }
      }
    }

    // 3. SiteData / SprinkleConfig (spin_r, spin_t, rev) — best-effort
    let spin_r: string | undefined;
    let spin_t: string | undefined;
    let hsi: string | undefined;
    let rev: string | undefined;
    const scripts2 = Array.from(document.querySelectorAll('script')).map((s) => s.textContent ?? '');
    for (const s of scripts2) {
      if (!spin_r) {
        const m = s.match(/"__spin_r":(\d+)/);
        if (m) spin_r = m[1];
      }
      if (!spin_t) {
        const m = s.match(/"__spin_t":(\d+)/);
        if (m) spin_t = m[1];
      }
      if (!hsi) {
        const m = s.match(/"hsi":"([^"]+)"/);
        if (m) hsi = m[1];
      }
      if (!rev) {
        const m = s.match(/"client_revision":(\d+)/) || s.match(/"rev":(\d+)/);
        if (m) rev = m[1];
      }
    }

    return {
      fb_dtsg: fb_dtsg ?? '',
      lsd,
      jazoest,
      spin_r,
      spin_t,
      hsi,
      rev,
      c_user: getCookie('c_user'),
    };
  });

  if (!ctx.fb_dtsg) {
    throw new Error('Failed to capture fb_dtsg — page may not be fully logged in');
  }
  return ctx;
}

export async function persistAuthContext(sessionId: number, ctx: AuthContext): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO fb_auth_context (session_id, fb_dtsg, lsd, jazoest, spin_r, spin_t, hsi, rev, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [sessionId, ctx.fb_dtsg, ctx.lsd ?? null, ctx.jazoest ?? null, ctx.spin_r ?? null, ctx.spin_t ?? null, ctx.hsi ?? null, ctx.rev ?? null, ctx]
  );
  return rows[0].id;
}
