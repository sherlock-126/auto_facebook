/**
 * Inline HTML email templates. Plain TS strings — no MJML.
 * Dark theme matching the app.
 */

const BASE_URL = process.env.APP_PUBLIC_BASE_URL ?? 'https://dev-fb.autonow.vn';

function wrap(title: string, body: string, ctaUrl?: string, ctaLabel?: string): string {
  const cta = ctaUrl && ctaLabel
    ? `<p style="margin:24px 0;"><a href="${ctaUrl}" style="background:#3b6ef0;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block;">${ctaLabel}</a></p>
       <p style="font-size:11px;color:#8a96bd;">Hoặc copy link: <br><span style="word-break:break-all;">${ctaUrl}</span></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f4f5fa;margin:0;padding:30px 0;">
  <table align="center" style="max-width:560px;background:#fff;border-radius:10px;padding:30px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
    <tr><td>
      <h2 style="margin:0 0 16px;color:#1a2240;font-size:20px;">${title}</h2>
      <div style="color:#3a4264;font-size:14px;line-height:1.6;">${body}</div>
      ${cta}
      <hr style="border:none;border-top:1px solid #e5e8f0;margin:30px 0 14px;">
      <p style="font-size:11px;color:#8a96bd;margin:0;">
        Email tự động từ <strong>fb.autonow.vn</strong> · Nếu bạn không yêu cầu, có thể bỏ qua email này.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function verifyEmailTemplate(args: { email: string; token: string }): { subject: string; html: string } {
  const url = `${BASE_URL}/auth/verify?t=${encodeURIComponent(args.token)}`;
  return {
    subject: '[fb.autonow.vn] Xác thực email của bạn',
    html: wrap(
      'Xác thực email',
      `Chào <strong>${escapeHtml(args.email)}</strong>,<br><br>
       Cảm ơn bạn đã đăng ký fb.autonow.vn. Bấm nút bên dưới để xác thực email và kích hoạt tài khoản.
       Link có hiệu lực trong <strong>24 giờ</strong>.`,
      url,
      'Xác thực email'
    ),
  };
}

export function passwordResetTemplate(args: { email: string; token: string }): { subject: string; html: string } {
  const url = `${BASE_URL}/auth/reset?t=${encodeURIComponent(args.token)}`;
  return {
    subject: '[fb.autonow.vn] Đặt lại mật khẩu',
    html: wrap(
      'Đặt lại mật khẩu',
      `Chào <strong>${escapeHtml(args.email)}</strong>,<br><br>
       Có yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Bấm nút bên dưới để chọn mật khẩu mới.
       Link có hiệu lực trong <strong>1 giờ</strong>.<br><br>
       Nếu bạn không yêu cầu, vui lòng bỏ qua email này — mật khẩu hiện tại vẫn an toàn.`,
      url,
      'Đặt lại mật khẩu'
    ),
  };
}

export function welcomeTemplate(args: { email: string; tenant_id: string; license_key: string }): { subject: string; html: string } {
  const installCmd = `curl -fsSL ${BASE_URL}/install.sh | LICENSE_KEY=${args.license_key} bash`;
  return {
    subject: '[fb.autonow.vn] Chào mừng đến với fb.autonow.vn 🎉',
    html: wrap(
      'Chào mừng!',
      `Xin chào <strong>${escapeHtml(args.email)}</strong>,<br><br>
       Tài khoản của bạn đã sẵn sàng. Workspace ID:
       <code style="background:#f0f2f8;padding:2px 6px;border-radius:3px;">${escapeHtml(args.tenant_id)}</code>
       <br><br>

       <strong style="display:block;margin:18px 0 8px;">🔑 License key của bạn</strong>
       <div style="background:#0a0f24;color:#9eecbe;padding:12px 14px;border-radius:6px;font-family:'SF Mono',Monaco,monospace;font-size:13px;word-break:break-all;">
         ${escapeHtml(args.license_key)}
       </div>
       <p style="font-size:11px;color:#8a96bd;margin:6px 0 0;">⚠️ Giữ kín license key — nó dùng để agent kết nối về cloud.</p>

       <strong style="display:block;margin:24px 0 8px;">🖥️ Cài agent trên VPS của bạn</strong>
       <p style="margin:0 0 8px;">SSH vào VPS (Ubuntu 22.04+, ≥4 CPU / 8GB RAM), chạy:</p>
       <div style="background:#0a0f24;color:#cad3ed;padding:14px;border-radius:6px;font-family:'SF Mono',Monaco,monospace;font-size:12px;overflow-x:auto;">
         ${escapeHtml(installCmd)}
       </div>
       <p style="font-size:11px;color:#8a96bd;margin:6px 0 0;">
         ℹ️ Agent installer đang trong giai đoạn beta. Email này được lưu lại — khi installer ready, lệnh trên sẽ hoạt động ngay với license key của bạn. Bạn sẽ nhận thông báo khi sẵn sàng.
       </p>

       <strong style="display:block;margin:24px 0 8px;">📋 Bước tiếp theo</strong>
       <ol style="padding-left:18px;margin:0;">
         <li>Đăng nhập web dashboard tại <a href="${BASE_URL}/auth/login" style="color:#3b6ef0;">${BASE_URL}/auth/login</a></li>
         <li>Đợi email tiếp theo với hướng dẫn cài agent (đang chuẩn bị)</li>
         <li>Sau khi agent connect, login Facebook 1 lần qua noVNC trên VPS của bạn</li>
         <li>Chọn group muốn crawl → hệ thống tự crawl 24/7 + AI phân loại lead</li>
       </ol>`,
      `${BASE_URL}/auth/login`,
      'Mở dashboard'
    ),
  };
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
