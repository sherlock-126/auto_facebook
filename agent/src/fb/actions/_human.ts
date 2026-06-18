/**
 * Human-like Playwright helpers — ported from autonow_local's fb-common.mjs.
 * Used by post_to_group + comment_on_post browser actions to mimic real-user
 * typing patterns + detect FB's anti-bot rate-limit banners.
 *
 * Tuned against FB's keystroke heuristics over many runs by the autonow team.
 * Do NOT "simplify" without re-validating on a real account.
 */
import type { Page } from 'playwright';

const rand = (lo: number, hi: number) => Math.floor(Math.random() * (hi - lo)) + lo;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Random delay in [loMs, hiMs] for between-action pauses. */
export function human(loMs: number, hiMs: number): Promise<void> {
  return sleep(rand(loMs, hiMs));
}

const SPEEDS: Record<string, [number, number]> = {
  fast:   [22, 55],   // bursts of fluent typing
  normal: [45, 110],  // default rhythm
  slow:   [90, 180],  // hesitant
};
const SPEED_KEYS = ['fast', 'normal', 'normal', 'normal', 'slow'] as const;
const NEIGHBORS: Record<string, string> = {
  a:'sqwz', b:'vghn', c:'xdfv', d:'sefcx', e:'wrsd', f:'drtgcv',
  g:'ftyhbv', h:'gyujnb', i:'uojk', j:'huiknm', k:'jiolm', l:'kop',
  m:'njk', n:'bhjm', o:'iplk', p:'ol', q:'wa', r:'edft', s:'awedxz',
  t:'rfgy', u:'yhji', v:'cfgb', w:'qase', x:'zsdc', y:'tghu', z:'asx',
};
function wrongFor(ch: string): string | null {
  const lower = ch.toLowerCase();
  const opts = NEIGHBORS[lower];
  if (!opts) return null;
  const pick = opts[rand(0, opts.length)];
  return ch === lower ? pick : pick.toUpperCase();
}

/** Type text into the focused element with humanised speed + typos + pauses. */
export async function humanizedType(page: Page, text: string): Promise<void> {
  let speed = SPEEDS[SPEED_KEYS[rand(0, SPEED_KEYS.length)]];
  let charsLeftInBurst = rand(8, 18);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (charsLeftInBurst-- <= 0) {
      speed = SPEEDS[SPEED_KEYS[rand(0, SPEED_KEYS.length)]];
      charsLeftInBurst = rand(8, 18);
    }

    // Occasional typo: type wrong char(s), pause, backspace, type correct.
    if (Math.random() < 0.035 && /[a-zA-Zà-ỹÀ-Ỹ]/.test(ch)) {
      const wrong = wrongFor(ch);
      if (wrong) {
        const wrongLen = Math.random() < 0.7 ? 1 : 2;
        for (let k = 0; k < wrongLen; k++) {
          await page.keyboard.type(k === 0 ? wrong : (wrongFor(ch) || wrong));
          await sleep(rand(speed[0], speed[1]));
        }
        await sleep(rand(180, 520));
        for (let k = 0; k < wrongLen; k++) {
          await page.keyboard.press('Backspace');
          await sleep(rand(40, 110));
        }
        await sleep(rand(80, 220));
      }
    }

    await page.keyboard.type(ch);
    await sleep(rand(speed[0], speed[1]));

    if (/[,;:]/.test(ch))      await sleep(rand(120, 280));
    else if (/[.!?]/.test(ch)) await sleep(rand(280, 600));
    else if (ch === '\n')      await sleep(rand(350, 800));

    if (Math.random() < 0.025) await sleep(rand(400, 1200));
  }
}

/** Throws if current page is a login screen (FB session expired). */
export async function ensureLoggedIn(page: Page): Promise<void> {
  const loginGate = await page.$('input[type=password], #email');
  if (loginGate) throw new Error('login_expired: Facebook login expired. Re-login via noVNC then retry.');
}

/** Detect FB's "temporarily blocked / unusual activity" banners. */
export function detectBlocked(text: string): boolean {
  return /(tạm thời bị chặn|temporarily blocked|hành vi bất thường|hạn chế tính năng|action blocked)/i.test(text || '');
}
