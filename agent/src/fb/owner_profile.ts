/**
 * Fetch the FB display name + avatar of the account currently logged into
 * chrome-profile (the account doing the crawl). Used by Dashboard to render a
 * proper account card instead of just the c_user ID.
 *
 * FB's public Graph picture endpoint returns a silhouette placeholder for
 * personal accounts (auth-walled). Instead we open facebook.com/me in our
 * already-logged-in Chrome and read the og:title + og:image meta tags — same
 * info FB feeds to crawlers/share previews, no auth dance needed.
 *
 * Cached for 7 days in a tiny JSON file so we only do this navigation once
 * per week (5-10s extra per stale tick).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openPage } from './browser.js';
import { getCUser } from './session.js';
import { log } from '../log.js';

const CACHE_PATH = '/var/lib/auto-facebook-agent/owner-profile.json';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OwnerProfile {
  name:        string | null;
  avatar_url:  string | null;
  fetched_at:  number;
}

export function readCachedOwnerProfile(): OwnerProfile | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  } catch { return null; }
}

function writeCache(p: OwnerProfile): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(p));
  } catch (e: any) { log('warn', `owner-profile cache write failed: ${e?.message}`); }
}

/**
 * Best-effort fetch of the FB profile name + avatar URL.
 * Returns cached value if fresh (<7 days) and force=false.
 * Returns cached value on error too (so we don't lose what we had).
 */
export async function fetchOwnerProfile(force = false): Promise<OwnerProfile | null> {
  const cached = readCachedOwnerProfile();
  if (!force && cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS) {
    return cached;
  }
  let page;
  try {
    const cUser = await getCUser();
    if (!cUser) { log('warn', 'owner-profile: no c_user in chrome-profile'); return cached; }
    page = await openPage();
    // Navigate to user's own profile page — FB always embeds the viewer's
    // identity (name + avatar) in the page's <script> JSON blobs even before
    // React hydrates. We grep these regardless of what the SPA does to
    // <title>/og:title (which may show "(N) Facebook" notification placeholder).
    const url = `https://www.facebook.com/profile.php?id=${cUser}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});

    const result = await page.evaluate((cu: string) => {
      const isJunk = (t: string | null | undefined): boolean => {
        if (!t) return true;
        const low = t.toLowerCase().trim();
        // Common navbar/menu labels we don't want, in multiple languages
        return ['facebook','thông báo','notifications','tin nhắn','messenger','menu','home','trang chủ','marketplace','watch'].includes(low);
      };
      const stripNoise = (s: string | null | undefined): string | null => {
        if (!s) return null;
        const t = s.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*Facebook\s*$/, '').trim();
        return (isJunk(t) ? null : t);
      };

      const allScripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent || '');
      const joined = allScripts.join('\\n');

      let name: string | null = null;
      let avatarUrl: string | null = null;

      // === Priority 1: script-blob grep (deterministic, ignores SPA state) ===
      const namePatterns: RegExp[] = [
        new RegExp('"(?:id|actor_id|userID)":"' + cu + '"[^{}]{0,400}?"name":"((?:[^"\\\\]|\\\\.)+)"'),
        new RegExp('"name":"((?:[^"\\\\]|\\\\.)+)"[^{}]{0,400}?"(?:id|actor_id|userID)":"' + cu + '"'),
        new RegExp('"(?:id|actor_id|userID)":"' + cu + '"[^{}]{0,400}?"short_name":"((?:[^"\\\\]|\\\\.)+)"'),
        new RegExp('"USER_ID":"' + cu + '","NAME":"((?:[^"\\\\]|\\\\.)+)"'),
        new RegExp('"NAME":"((?:[^"\\\\]|\\\\.)+)","USER_ID":"' + cu + '"'),
      ];
      for (const re of namePatterns) {
        const m = joined.match(re);
        if (m && m[1]) {
          let cand: string | null;
          try { cand = JSON.parse('"' + m[1] + '"'); } catch { cand = m[1]; }
          if (cand && !isJunk(cand)) { name = cand; break; }
        }
      }

      // === Priority 2: og:title (only if non-junk) ===
      if (!name) name = stripNoise(document.querySelector('meta[property="og:title"]')?.getAttribute('content'));
      // === Priority 3: <title> ===
      if (!name) name = stripNoise(document.title);
      // === Priority 4: h1 (LAST resort — picks up navbar junk in SPA) ===
      if (!name) {
        for (const h1 of Array.from(document.querySelectorAll('h1'))) {
          const t = stripNoise(h1.textContent);
          if (t) { name = t; break; }
        }
      }

      // === Avatar: script grep first, then DOM scan ===
      const avatarPatterns: RegExp[] = [
        new RegExp('"(?:id|actor_id|userID)":"' + cu + '"[^{}]{0,800}?"profile_picture":\\\\{[^{}]*?"uri":"((?:[^"\\\\]|\\\\.)+)"'),
        new RegExp('"(?:id|actor_id|userID)":"' + cu + '"[^{}]{0,800}?"profilePicLarge":\\\\{[^{}]*?"uri":"((?:[^"\\\\]|\\\\.)+)"'),
        new RegExp('"profile_picture":\\\\{[^{}]*?"uri":"((?:[^"\\\\]|\\\\.)+)"[^{}]{0,400}?"(?:id|actor_id|userID)":"' + cu + '"'),
      ];
      for (const re of avatarPatterns) {
        const m = joined.match(re);
        if (m && m[1]) {
          try { avatarUrl = JSON.parse('"' + m[1] + '"'); } catch { avatarUrl = m[1]; }
          if (avatarUrl) break;
        }
      }
      // Fallback A: SVG <image> elements (FB renders profile avatar as SVG image in a circle clip)
      if (!avatarUrl) {
        const svgImgs = Array.from(document.querySelectorAll('image'));
        for (const im of svgImgs as any) {
          const href = im.getAttribute('xlink:href') || im.getAttribute('href') || '';
          if (href.includes('fbcdn') && href.includes('http')) { avatarUrl = href; break; }
        }
      }
      // Fallback B: any <img> with alt matching the resolved name
      if (!avatarUrl && name) {
        const safe = name.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
        const hit = imgs.find(im => (im.alt || '').match(new RegExp(safe, 'i')) && im.src.includes('fbcdn'));
        if (hit) avatarUrl = hit.src;
      }
      // Fallback C: largest fbcdn <img> in the page (profile photo is biggest on profile.php)
      if (!avatarUrl) {
        const imgs = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
        const fbImgs = imgs.filter(im => im.src && im.src.includes('fbcdn'));
        fbImgs.sort((a, b) => (b.naturalWidth * b.naturalHeight || b.width * b.height) - (a.naturalWidth * a.naturalHeight || a.width * a.height));
        if (fbImgs[0] && fbImgs[0].src) avatarUrl = fbImgs[0].src;
      }
      // Fallback E: og:image (often generic but worth trying)
      if (!avatarUrl) {
        avatarUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;
      }

      return { name, avatar_url: avatarUrl };
    }, cUser);

    // Last resort: hit facebook.com/<cuser>/picture (302 redirect → fbcdn URL).
    // Uses the page's authenticated context. Don't fetch the bytes — just
    // follow the redirect chain and grab the final URL.
    if (!result.avatar_url) {
      try {
        const resp = await page.context().request.get(
          `https://www.facebook.com/${cUser}/picture?type=large&width=200`,
          { maxRedirects: 5, timeout: 8_000 }
        );
        const finalUrl = resp.url();
        if (finalUrl && finalUrl.includes('fbcdn')) {
          result.avatar_url = finalUrl;
          log('info', 'owner-profile: avatar via /picture redirect');
        }
      } catch (e: any) { log('warn', `owner-profile: /picture fetch failed: ${e?.message}`); }
    }
    if (!result.name && !result.avatar_url) {
      log('warn', 'owner-profile: og tags empty, returning cached');
      return cached;
    }
    const profile: OwnerProfile = {
      name:       result.name,
      avatar_url: result.avatar_url,
      fetched_at: Date.now(),
    };
    writeCache(profile);
    log('info', `owner-profile fetched: name=${profile.name?.slice(0, 40)} avatar=${profile.avatar_url ? 'yes' : 'no'}`);
    return profile;
  } catch (e: any) {
    log('warn', `owner-profile fetch failed: ${e?.message ?? e} — using cache`);
    return cached;
  } finally {
    try { await page?.close(); } catch {}
  }
}
