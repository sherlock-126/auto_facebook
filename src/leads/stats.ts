/**
 * Lead analytics queries for the Reports dashboard.
 *
 *  - getFunnel:    leads per stage (in pipeline order)
 *  - getDailyStats: leads created per day, last N days
 *  - getVelocity:  avg days each lead spent in each stage (from lead_history transitions)
 *  - getHeatmap:   when leads land in inbox (day-of-week × hour-of-day)
 */
import { pool } from '../db.js';
import { STAGE_VALUES, STAGE_LABELS, type Stage } from './pipeline.js';

export interface FunnelRow { stage: Stage; label: string; count: number; }
export interface DailyRow  { date: string; leads: number; }
export interface VelRow    { stage: Stage; label: string; avg_days: number; n_samples: number; }
export interface HeatCell  { dow: number; hour: number; count: number; }

export async function getFunnel(tenantId: string): Promise<{ stages: FunnelRow[] }> {
  const { rows } = await pool.query(
    `SELECT stage, count(*)::int AS n FROM fact_lead WHERE tenant_id=$1 GROUP BY stage`,
    [tenantId]
  );
  const counts = new Map<string, number>(rows.map((r: any) => [r.stage, r.n]));
  return {
    stages: STAGE_VALUES.map((s) => ({
      stage: s,
      label: STAGE_LABELS[s],
      count: counts.get(s) ?? 0,
    })),
  };
}

export async function getDailyStats(tenantId: string, days = 30): Promise<{ days: DailyRow[] }> {
  const { rows } = await pool.query(
    `WITH series AS (
       SELECT generate_series(
         date_trunc('day', now() - ($2 || ' days')::interval),
         date_trunc('day', now()),
         '1 day'::interval
       )::date AS day
     )
     SELECT to_char(s.day, 'YYYY-MM-DD') AS date,
            COALESCE(count(l.lead_id), 0)::int AS leads
       FROM series s
       LEFT JOIN fact_lead l
         ON date_trunc('day', l.detected_at) = s.day AND l.tenant_id = $1
      GROUP BY s.day
      ORDER BY s.day`,
    [tenantId, days]
  );
  return { days: rows };
}

export async function getVelocity(tenantId: string): Promise<{ stages: VelRow[] }> {
  // For each stage_changed event, compute time from previous stage_changed (or detected_at) to this event.
  // Average per source stage (from_value).
  const { rows } = await pool.query(
    `WITH transitions AS (
       SELECT lh.lead_id,
              lh.from_value AS stage_from,
              lh.to_value   AS stage_to,
              lh.created_at AS at,
              LAG(lh.created_at) OVER (PARTITION BY lh.lead_id ORDER BY lh.created_at) AS prev_at,
              l.detected_at
         FROM lead_history lh
         JOIN fact_lead l ON l.lead_id = lh.lead_id AND l.tenant_id = $1
        WHERE lh.action = 'stage_changed'
     )
     SELECT stage_from AS stage,
            avg(EXTRACT(EPOCH FROM (at - COALESCE(prev_at, detected_at))) / 86400.0)::float AS avg_days,
            count(*)::int AS n
       FROM transitions
      WHERE stage_from IS NOT NULL
      GROUP BY stage_from`,
    [tenantId]
  );
  const m = new Map<string, { avg_days: number; n: number }>(
    rows.map((r: any) => [r.stage, { avg_days: r.avg_days, n: r.n }])
  );
  return {
    stages: STAGE_VALUES.map((s) => ({
      stage:     s,
      label:     STAGE_LABELS[s],
      avg_days:  Number((m.get(s)?.avg_days ?? 0).toFixed(2)),
      n_samples: m.get(s)?.n ?? 0,
    })),
  };
}

export async function getHeatmap(tenantId: string, days = 30): Promise<{ cells: HeatCell[] }> {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DOW  FROM detected_at)::int AS dow,
            EXTRACT(HOUR FROM detected_at)::int AS hour,
            count(*)::int AS count
       FROM fact_lead
      WHERE tenant_id = $1 AND detected_at > now() - ($2 || ' days')::interval
      GROUP BY dow, hour`,
    [tenantId, days]
  );
  return { cells: rows };
}
