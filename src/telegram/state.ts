/**
 * Transient conversation state per (tenant, chat). Telegram is stateless per
 * request, so when the bot asks a multi-turn question ("pick a group") we
 * store the question's context here and consult it on the next inbound update.
 *
 * TTL is 30 min — long enough for users who get distracted, short enough to
 * forget stale flows. setState() upserts so the latest flow wins (clicking
 * /post mid-edit aborts the edit). clearExpired() runs from a cron in server.ts.
 */
import { pool } from '../db.js';

export type StateName =
  | 'compose_pick_variant'   // bot showed variants, waiting for tap
  | 'compose_pick_group'     // user picked variant, waiting for group tap
  | 'compose_input_idea'     // user sent /post with no body, waiting for next message
  | 'reply_edit_text';       // user tapped ✏ Edit on a reply card, waiting for replacement text

export interface BotState {
  tenant_id: string;
  chat_id:   string;
  state_name: StateName;
  payload:   any;
}

export async function setState(s: BotState, ttlMinutes = 30): Promise<void> {
  await pool.query(
    `INSERT INTO fb_bot_state (tenant_id, chat_id, state_name, payload, expires_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW() + ($5 || ' minutes')::interval, NOW())
     ON CONFLICT (tenant_id, chat_id) DO UPDATE
       SET state_name = EXCLUDED.state_name,
           payload    = EXCLUDED.payload,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [s.tenant_id, s.chat_id, s.state_name, JSON.stringify(s.payload ?? {}), String(ttlMinutes)],
  );
}

export async function getState(tenantId: string, chatId: string): Promise<BotState | null> {
  const { rows } = await pool.query(
    `SELECT tenant_id, chat_id, state_name, payload
       FROM fb_bot_state
      WHERE tenant_id = $1 AND chat_id = $2 AND expires_at > NOW()`,
    [tenantId, chatId],
  );
  return rows[0] ?? null;
}

export async function clearState(tenantId: string, chatId: string): Promise<void> {
  await pool.query(`DELETE FROM fb_bot_state WHERE tenant_id = $1 AND chat_id = $2`, [tenantId, chatId]);
}

export async function clearExpired(): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM fb_bot_state WHERE expires_at <= NOW()`);
  return rowCount ?? 0;
}
