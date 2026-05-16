import { pool } from '../db.js';

const DAILY_BUDGET = Number(process.env.FB_DAILY_REQUEST_BUDGET ?? 400);

export class BudgetExceededError extends Error {
  constructor(cUser: string, used: number) {
    super(`Daily request budget exceeded for c_user=${cUser} (used ${used}/${DAILY_BUDGET})`);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function consumeBudget(cUser: string, n = 1): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO fb_request_budget (c_user, day, count) VALUES ($1, $2, $3)
     ON CONFLICT (c_user, day) DO UPDATE SET count = fb_request_budget.count + EXCLUDED.count
     RETURNING count`,
    [cUser, today(), n]
  );
  const used = rows[0].count as number;
  if (used > DAILY_BUDGET) throw new BudgetExceededError(cUser, used);
  return used;
}

export async function getBudget(cUser: string): Promise<{ used: number; limit: number }> {
  const { rows } = await pool.query(
    'SELECT count FROM fb_request_budget WHERE c_user = $1 AND day = $2',
    [cUser, today()]
  );
  return { used: rows[0]?.count ?? 0, limit: DAILY_BUDGET };
}

export function randomDelayMs(): number {
  const min = Number(process.env.FB_DELAY_MIN_SEC ?? 25) * 1000;
  const max = Number(process.env.FB_DELAY_MAX_SEC ?? 55) * 1000;
  // Gaussian-ish jitter (sum of two uniforms)
  const u1 = Math.random();
  const u2 = Math.random();
  const t = (u1 + u2) / 2;
  return Math.floor(min + (max - min) * t);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
