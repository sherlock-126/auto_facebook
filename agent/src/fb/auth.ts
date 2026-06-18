/**
 * Extract FB CSRF / session tokens from a logged-in page.
 * 1:1 port from cloud's src/fb/auth.ts minus the DB persistence (agent keeps it in-memory).
 *
 * Tokens rotate (esp. fb_dtsg every few hours). If a replay returns
 * `errorCode: 1357004` ("Invalid form data"), call captureAuthContext again.
 */
import type { Page } from 'playwright';

export interface AuthContext {
  fb_dtsg: string;
  lsd?:    string;
  jazoest?:string;
  spin_r?: string;
  spin_t?: string;
  hsi?:    string;
  rev?:    string;
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

    let fb_dtsg = getInput('fb_dtsg');
    let lsd     = getInput('lsd');
    let jazoest = getInput('jazoest');

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

    let spin_r: string | undefined;
    let spin_t: string | undefined;
    let hsi:    string | undefined;
    let rev:    string | undefined;
    const scripts2 = Array.from(document.querySelectorAll('script')).map((s) => s.textContent ?? '');
    for (const s of scripts2) {
      if (!spin_r) { const m = s.match(/"__spin_r":(\d+)/); if (m) spin_r = m[1]; }
      if (!spin_t) { const m = s.match(/"__spin_t":(\d+)/); if (m) spin_t = m[1]; }
      if (!hsi)    { const m = s.match(/"hsi":"([^"]+)"/);  if (m) hsi    = m[1]; }
      if (!rev)    {
        const m = s.match(/"client_revision":(\d+)/) || s.match(/"rev":(\d+)/);
        if (m) rev = m[1];
      }
    }

    return { fb_dtsg: fb_dtsg ?? '', lsd, jazoest, spin_r, spin_t, hsi, rev, c_user: getCookie('c_user') };
  });

  if (!ctx.fb_dtsg) {
    throw new Error('Failed to capture fb_dtsg — page may not be fully logged in');
  }
  return ctx;
}
