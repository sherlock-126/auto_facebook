/**
 * Persist token-usage + cost metadata for every Gemini call so the Settings
 * tab can render daily charts and est. operational cost.
 *
 * Pricing is read from env (per 1M tokens, USD). Defaults match gemini-2.5-flash
 * non-thinking tier circa 2026-Q2. Override via env if pricing changes.
 *
 *   GEMINI_PRICE_INPUT_USD_PER_1M   (default 0.30)
 *   GEMINI_PRICE_OUTPUT_USD_PER_1M  (default 2.50)
 *   GEMINI_PRICE_CACHED_USD_PER_1M  (default 0.075)
 *   GEMINI_USD_VND                  (default 25500)
 */
import { pool } from '../db.js';

export interface UsageMetadata {
  promptTokenCount?:      number;
  candidatesTokenCount?:  number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?:    number;
  totalTokenCount?:       number;
}

export interface PricingUSD {
  input_per_1m:  number;
  output_per_1m: number;
  cached_per_1m: number;
  usd_vnd:       number;
}

export function getPricing(): PricingUSD {
  const num = (k: string, dflt: number) => {
    const v = parseFloat(process.env[k] ?? '');
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  return {
    input_per_1m:  num('GEMINI_PRICE_INPUT_USD_PER_1M',  0.30),
    output_per_1m: num('GEMINI_PRICE_OUTPUT_USD_PER_1M', 2.50),
    cached_per_1m: num('GEMINI_PRICE_CACHED_USD_PER_1M', 0.075),
    usd_vnd:       num('GEMINI_USD_VND',                 25500),
  };
}

export function estimateCostUsd(
  promptTokens: number, outputTokens: number, cachedTokens: number,
  p: PricingUSD = getPricing(),
): number {
  const billableInput = Math.max(0, promptTokens - cachedTokens);
  return (
    (billableInput  * p.input_per_1m)  / 1_000_000 +
    (outputTokens   * p.output_per_1m) / 1_000_000 +
    (cachedTokens   * p.cached_per_1m) / 1_000_000
  );
}

export async function logGeminiUsage(
  tenantId: string,
  model:    string,
  purpose:  string,
  usage:    UsageMetadata | null | undefined,
  ok:       boolean,
  err?:     string | null,
): Promise<void> {
  try {
    const prompt = Number(usage?.promptTokenCount       ?? 0) | 0;
    const output = Number(usage?.candidatesTokenCount   ?? 0) | 0;
    const cached = Number(usage?.cachedContentTokenCount ?? 0) | 0;
    const think  = Number(usage?.thoughtsTokenCount     ?? 0) | 0;
    const total  = Number(usage?.totalTokenCount        ?? (prompt + output + think)) | 0;
    await pool.query(
      `INSERT INTO gemini_usage
         (tenant_id, model, purpose, prompt_tokens, output_tokens, cached_tokens, thinking_tokens, total_tokens, ok, err)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, model, purpose, prompt, output, cached, think, total, ok, err ?? null],
    );
  } catch (e: any) {
    // Never let logging break the caller.
    console.warn(`[gemini_usage] log failed: ${e?.message ?? e}`);
  }
}
