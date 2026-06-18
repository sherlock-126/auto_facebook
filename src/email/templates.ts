/**
 * Inline HTML email templates. Plain TS strings — no MJML.
 * Light, deliverable email shell with the nextclaw lime accent on the CTA.
 */

const BASE_URL = process.env.APP_PUBLIC_BASE_URL ?? 'https://nextclaw.vn';

function wrap(title: string, body: string, ctaUrl?: string, ctaLabel?: string): string {
  const cta = ctaUrl && ctaLabel
    ? `<p style="margin:24px 0;"><a href="${ctaUrl}" style="background:#C2F24A;color:#0E1430;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;display:inline-block;">${ctaLabel}</a></p>
       <p style="font-size:11px;color:#8a96bd;">Or paste this link:<br><span style="word-break:break-all;">${ctaUrl}</span></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#eef0f6;margin:0;padding:30px 0;">
  <table align="center" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;margin:0 auto;box-shadow:0 2px 14px rgba(14,20,48,0.08);">
    <tr><td>
      <div style="font-weight:700;font-size:16px;color:#0E1430;letter-spacing:-0.02em;margin-bottom:18px;">&#9670; nextclaw</div>
      <h2 style="margin:0 0 16px;color:#0E1430;font-size:21px;">${title}</h2>
      <div style="color:#3a4264;font-size:14px;line-height:1.6;">${body}</div>
      ${cta}
      <hr style="border:none;border-top:1px solid #e5e8f0;margin:30px 0 14px;">
      <p style="font-size:11px;color:#8a96bd;margin:0;">
        Automated message from <strong>nextclaw</strong> &middot; If you didn't request this, you can ignore it.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function verifyEmailTemplate(args: { email: string; token: string }): { subject: string; html: string } {
  const url = `${BASE_URL}/auth/verify?t=${encodeURIComponent(args.token)}`;
  return {
    subject: '[nextclaw] Verify your email',
    html: wrap(
      'Verify your email',
      `Hi <strong>${escapeHtml(args.email)}</strong>,<br><br>
       Thanks for signing up for nextclaw. Tap the button below to verify your email and join the activation queue.
       This link is valid for <strong>24 hours</strong>.`,
      url,
      'Verify email'
    ),
  };
}

export function passwordResetTemplate(args: { email: string; token: string }): { subject: string; html: string } {
  const url = `${BASE_URL}/auth/reset?t=${encodeURIComponent(args.token)}`;
  return {
    subject: '[nextclaw] Reset your password',
    html: wrap(
      'Reset your password',
      `Hi <strong>${escapeHtml(args.email)}</strong>,<br><br>
       We got a request to reset your password. Tap the button below to choose a new one.
       This link is valid for <strong>1 hour</strong>.<br><br>
       If you didn't request this, ignore this email — your current password stays safe.`,
      url,
      'Reset password'
    ),
  };
}

export function welcomeTemplate(args: { email: string; tenant_id: string; license_key: string }): { subject: string; html: string } {
  const installCmd = `curl -fsSL ${BASE_URL}/install.sh | sudo bash -s ${args.license_key}`;
  return {
    subject: '[nextclaw] Your account is active 🎉',
    html: wrap(
      'You’re in — let’s catch some leads',
      `Hi <strong>${escapeHtml(args.email)}</strong>,<br><br>
       Your account is active. Workspace ID:
       <code style="background:#f0f2f8;padding:2px 6px;border-radius:4px;">${escapeHtml(args.tenant_id)}</code>
       <br><br>

       <strong style="display:block;margin:18px 0 8px;">&#128273; Your license key</strong>
       <div style="background:#0E1430;color:#C2F24A;padding:12px 14px;border-radius:8px;font-family:'SF Mono',Monaco,monospace;font-size:13px;word-break:break-all;">
         ${escapeHtml(args.license_key)}
       </div>
       <p style="font-size:11px;color:#8a96bd;margin:6px 0 0;">Keep this private — it's how your agent connects to nextclaw.</p>

       <strong style="display:block;margin:24px 0 8px;">&#128421;&#65039; Install the agent on your server</strong>
       <p style="margin:0 0 8px;">SSH into your VPS (Ubuntu 22.04+, ~2.5GB+ RAM) and run:</p>
       <div style="background:#0E1430;color:#cad3ed;padding:14px;border-radius:8px;font-family:'SF Mono',Monaco,monospace;font-size:12px;overflow-x:auto;">
         ${escapeHtml(installCmd)}
       </div>
       <p style="font-size:11px;color:#8a96bd;margin:6px 0 0;">One command installs everything the agent needs.</p>

       <strong style="display:block;margin:24px 0 8px;">&#128203; Next steps</strong>
       <ol style="padding-left:18px;margin:0;">
         <li>Log in to your dashboard at <a href="${BASE_URL}/auth/login" style="color:#0E1430;font-weight:600;">${BASE_URL}/auth/login</a></li>
         <li>Run the install command above on your VPS</li>
         <li>Once the agent connects, log into Facebook once through the private browser on your VPS</li>
         <li>Enable the groups you want — nextclaw catches buyers 24/7 and scores them for you</li>
       </ol>`,
      `${BASE_URL}/auth/login`,
      'Open dashboard'
    ),
  };
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
