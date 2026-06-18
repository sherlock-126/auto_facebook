/**
 * Customer-facing blocklist actions. Called from:
 *   - Telegram `🚫 Block <ORG>` callback (lead_block:<lead_id>)
 *   - Dashboard REST  POST /api/blocklist/from-lead
 *
 * Effect of blocking an org:
 *   1. Insert into lead_blocklist (scope='org') so future leads with matching
 *      org_name_norm are silently dropped pre-INSERT in detector.ts.
 *   2. Auto-archive all existing OPEN leads of the same org → stage='closed_lost'.
 *      Sends note into lead_history for audit so user can see what got swept.
 */
import { pool } from '../db.js';
import { editMessageText, answerCallbackQuery, escapeHtml } from '../telegram/api.js';
import { normalizeOrgName } from './detector.js';

export interface BlockLeadResult {
  ok: boolean;
  org_name?:    string | null;
  archived?:    number;
  already_blocked?: boolean;
  error?: string;
}

/** Block by lead_id — looks up lead → blocks its org → archives siblings. */
export async function blockOrgFromLead(
  tenantId: string,
  leadId: number,
  actor: string,
  via: 'telegram' | 'dashboard',
): Promise<BlockLeadResult> {
  const { rows } = await pool.query(
    `SELECT org_name, org_name_norm, author_id
       FROM fact_lead WHERE lead_id = $1 AND tenant_id = $2`,
    [leadId, tenantId],
  );
  const lead = rows[0];
  if (!lead) return { ok: false, error: 'lead_not_found' };
  if (!lead.org_name_norm) return { ok: false, error: 'no_org_name', org_name: lead.org_name ?? null };
  const orgNorm = lead.org_name_norm;
  const orgDisplay = lead.org_name ?? orgNorm;

  // Insert blocklist (idempotent).
  const { rowCount: ins } = await pool.query(
    `INSERT INTO lead_blocklist (tenant_id, scope, pattern, display_name, created_by, created_via)
     VALUES ($1, 'org', $2, $3, $4, $5)
     ON CONFLICT (tenant_id, scope, pattern) DO NOTHING`,
    [tenantId, orgNorm, orgDisplay, actor, via],
  );

  // Auto-archive sibling open leads.
  const { rows: archived } = await pool.query(
    `UPDATE fact_lead
        SET stage = 'closed_lost', updated_at = NOW()
      WHERE tenant_id = $1
        AND org_name_norm = $2
        AND stage NOT IN ('closed_won', 'closed_lost')
     RETURNING lead_id`,
    [tenantId, orgNorm],
  );
  if (archived.length) {
    const params: any[] = [];
    const values = archived.map((r: any, i: number) => {
      params.push(r.lead_id, 'closed_lost', `auto-archived by ${via} block of "${orgDisplay}"`, actor);
      const off = i * 4;
      return `($${off + 1}, 'stage_changed', $${off + 2}, $${off + 3}, $${off + 4})`;
    }).join(', ');
    await pool.query(
      `INSERT INTO lead_history (lead_id, action, to_value, note, actor) VALUES ${values}`,
      params,
    );
  }

  return {
    ok: true,
    org_name: orgDisplay,
    archived: archived.length,
    already_blocked: ins === 0,
  };
}

/** Telegram inline-button callback handler. */
export async function handleLeadBlockCallback(
  tenantId: string,
  botToken: string,
  chatId: string,
  userEmail: string | null,
  callbackId: string,
  data: string,
  messageId: number | null,
): Promise<void> {
  const id = parseInt(data.slice('lead_block:'.length), 10);
  if (!Number.isFinite(id)) {
    await answerCallbackQuery(botToken, callbackId, 'Invalid lead id');
    return;
  }
  const r = await blockOrgFromLead(tenantId, id, userEmail ?? 'telegram', 'telegram');
  if (!r.ok) {
    if (r.error === 'no_org_name') {
      await answerCallbackQuery(botToken, callbackId, 'Lead này không có org_name để block');
    } else {
      await answerCallbackQuery(botToken, callbackId, `Lỗi: ${r.error}`);
    }
    return;
  }
  await answerCallbackQuery(botToken, callbackId, r.already_blocked ? 'Đã block từ trước' : '✓ Đã block');
  if (messageId) {
    const head = r.already_blocked
      ? `ℹ <b>${escapeHtml(r.org_name ?? '?')}</b> đã có trong blocklist từ trước`
      : `🚫 <b>Đã block ${escapeHtml(r.org_name ?? '?')}</b>`;
    const body = (r.archived ?? 0) > 0
      ? `Auto-archive <b>${r.archived}</b> lead cũ → kanban "Mất lead".`
      : `Chưa có lead nào khác cùng công ty cần archive.`;
    await editMessageText(botToken, chatId, messageId,
      `${head}\n\n${body}\n\n<i>Mở dashboard → Settings → Blocklist để remove nếu nhầm.</i>`);
  }
}

// Re-export helper for callers that need it without importing detector.ts
export { normalizeOrgName };
