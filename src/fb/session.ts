import { pool } from '../db.js';
import type { BrowserContext } from 'playwright';

export interface StorageState {
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

function extractCUser(state: StorageState): string | null {
  const c = state.cookies.find((x) => x.name === 'c_user');
  return c?.value ?? null;
}

export async function saveSession(context: BrowserContext, label?: string): Promise<{ id: number; c_user: string | null }> {
  const state = (await context.storageState()) as StorageState;
  const c_user = extractCUser(state);
  if (!c_user) throw new Error('No c_user cookie found — not logged in?');
  const finalLabel = label ?? `fb-${c_user}-${new Date().toISOString().slice(0, 16)}`;
  // Deactivate older sessions for the same c_user
  await pool.query('UPDATE fb_session SET is_active = FALSE WHERE c_user = $1', [c_user]);
  const { rows } = await pool.query(
    `INSERT INTO fb_session (label, storage_state, c_user, is_active)
     VALUES ($1, $2, $3, TRUE)
     RETURNING id`,
    [finalLabel, state, c_user]
  );
  return { id: rows[0].id, c_user };
}

export async function loadActiveSession(): Promise<{ id: number; c_user: string; storage_state: StorageState } | null> {
  const { rows } = await pool.query(
    `SELECT id, c_user, storage_state
       FROM fb_session
      WHERE is_active = TRUE
      ORDER BY created_at DESC
      LIMIT 1`
  );
  if (!rows[0]) return null;
  await pool.query('UPDATE fb_session SET last_used_at = now() WHERE id = $1', [rows[0].id]);
  return rows[0];
}
