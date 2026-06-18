/**
 * Resend transactional email wrapper.
 * Falls back to no-op + console log if RESEND_API_KEY missing — useful for dev.
 */
import { Resend } from 'resend';

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM ?? 'noreply@autonow.vn';

let client: Resend | null = null;
function getClient(): Resend | null {
  if (!KEY) return null;
  if (!client) client = new Resend(KEY);
  return client;
}

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(args: SendArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  const c = getClient();
  if (!c) {
    // Dev fallback: log full email so devs can copy verification links from terminal
    console.log(`\n[email:DEV-FALLBACK] no RESEND_API_KEY\n  to: ${args.to}\n  subject: ${args.subject}\n  html (first 500): ${args.html.slice(0, 500)}\n`);
    return { ok: true, id: 'dev-fallback' };
  }
  try {
    const res = await c.emails.send({
      from: FROM,
      to: [args.to],
      subject: args.subject,
      html: args.html,
    });
    if (res.error) {
      console.error(`[email] resend error: ${JSON.stringify(res.error)}`);
      return { ok: false, error: String(res.error) };
    }
    return { ok: true, id: res.data?.id };
  } catch (e: any) {
    console.error(`[email] send threw: ${e?.message ?? e}`);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function emailEnabled(): boolean {
  return !!KEY;
}
