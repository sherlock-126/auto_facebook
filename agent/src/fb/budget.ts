/**
 * Daily FB request budget counter — in-process (no DB). Resets at UTC midnight.
 * Customer can override via FB_DAILY_REQUEST_BUDGET env in /etc/auto-facebook-agent/config.json.
 */
const DAILY_BUDGET = Number(process.env.FB_DAILY_REQUEST_BUDGET ?? 3000);

export class BudgetExceededError extends Error {
  constructor(cUser: string, used: number) {
    super(`Daily request budget exceeded for c_user=${cUser} (used ${used}/${DAILY_BUDGET})`);
  }
}

function today(): string { return new Date().toISOString().slice(0, 10); }

const counters: Map<string /*c_user*/, { day: string; count: number }> = new Map();

export function consumeBudget(cUser: string, n = 1): number {
  const day = today();
  const entry = counters.get(cUser);
  if (!entry || entry.day !== day) {
    counters.set(cUser, { day, count: n });
  } else {
    entry.count += n;
  }
  const used = counters.get(cUser)!.count;
  if (used > DAILY_BUDGET) throw new BudgetExceededError(cUser, used);
  return used;
}

export function getBudget(cUser: string): { used: number; limit: number } {
  const day = today();
  const e = counters.get(cUser);
  return { used: (e && e.day === day) ? e.count : 0, limit: DAILY_BUDGET };
}

export function randomDelayMs(): number {
  const min = Number(process.env.FB_DELAY_MIN_SEC ?? 10) * 1000;
  const max = Number(process.env.FB_DELAY_MAX_SEC ?? 25) * 1000;
  const u1 = Math.random();
  const u2 = Math.random();
  const t  = (u1 + u2) / 2;
  return Math.floor(min + (max - min) * t);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
