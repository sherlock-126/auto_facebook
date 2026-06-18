/**
 * Auth UI: signup / login / verify / forgot / reset.
 * Standalone HTML pages (not part of the app shell). Dark theme.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · fb.autonow.vn</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #0b1020; color: #e8ecf3; }
  body { display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: #131a33; border: 1px solid #222a4a; border-radius: 12px; padding: 32px; width: 100%; max-width: 380px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .brand { color: #7ea7ff; font-size: 12px; margin-bottom: 22px; }
  label { display: block; font-size: 12px; color: #a9b3d1; margin: 14px 0 5px; }
  input { width: 100%; background: #0a0f24; color: #e8ecf3; border: 1px solid #222a4a; border-radius: 6px; padding: 10px 12px; font-size: 14px; font-family: inherit; }
  input:focus { outline: none; border-color: #3b6ef0; }
  button { width: 100%; background: #3b6ef0; color: #fff; border: 0; padding: 11px; border-radius: 6px; font-size: 14px; font-weight: 600; margin-top: 18px; cursor: pointer; }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .alt { font-size: 12px; color: #8a96bd; margin-top: 18px; text-align: center; }
  .alt a { color: #7ea7ff; text-decoration: none; }
  .msg { padding: 9px 12px; border-radius: 6px; font-size: 12px; margin-bottom: 12px; display: none; }
  .msg.show { display: block; }
  .msg.ok { background: #1f3f2a; color: #9eecbe; border: 1px solid #2a5a3b; }
  .msg.err { background: #3a1c28; color: #ff9aa3; border: 1px solid #4a1f24; }
  .msg.info { background: #1a2240; color: #cad3ed; border: 1px solid #222a4a; }
  .hint { font-size: 11px; color: #8a96bd; margin-top: 4px; }
</style>
<script>
// Helpers must be defined BEFORE the body's inline scripts run (otherwise the
// login page's IIFE that reads ?msg= would ReferenceError, halt execution, and
// the form's onSubmit handler would never bind — leading to the browser GETing
// the form (with credentials in the URL) instead of our POST fetch.
function showMsg(type, text) {
  var el = document.getElementById('msg');
  el.className = 'msg show ' + type;
  el.innerHTML = text;
}
function getQS(name) { return new URLSearchParams(location.search).get(name); }
</script>
</head><body>
<div class="card">
  <h1>${esc(title)}</h1>
  <div class="brand">fb.autonow.vn · FB Group Intelligence</div>
  ${body}
</div>
</body></html>`;
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export async function registerAuthPages(app: FastifyInstance): Promise<void> {
  // ---- SIGNUP ----
  app.get('/auth/signup', async (_req, reply) => {
    reply.type('text/html').send(shell('Đăng ký', `
      <div id="msg" class="msg"></div>
      <form id="f">
        <label>Tên workspace (tùy chọn)</label>
        <input name="tenant_name" placeholder="vd: ACME Corp" maxlength="80">
        <div class="hint">Mặc định lấy từ email nếu bỏ trống</div>
        <label>Email</label>
        <input name="email" type="email" required autocomplete="email">
        <label>Mật khẩu</label>
        <input name="password" type="password" required minlength="8" autocomplete="new-password">
        <div class="hint">Ít nhất 8 ký tự</div>
        <button type="submit" id="btn">Tạo tài khoản</button>
      </form>
      <div class="alt">Đã có tài khoản? <a href="/auth/login">Đăng nhập</a></div>
      <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = '⏳ Đang xử lý…';
        var data = Object.fromEntries(new FormData(e.target));
        try {
          var r = await fetch('/auth/signup', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data) });
          var j = await r.json();
          if (j.ok) {
            showMsg('ok', '✅ Đã gửi email xác thực tới ' + data.email + '. Sau khi xác thực, tài khoản sẽ vào hàng đợi duyệt — bạn sẽ nhận email khi admin approve.');
            btn.textContent = 'Đã gửi email';
          } else {
            showMsg('err', '❌ ' + (j.message || j.error || 'Lỗi không xác định'));
            btn.disabled = false; btn.textContent = 'Tạo tài khoản';
          }
        } catch (err) {
          showMsg('err', '❌ Lỗi mạng: ' + err.message);
          btn.disabled = false; btn.textContent = 'Tạo tài khoản';
        }
      });
      </script>
    `));
  });

  // ---- LOGIN ----
  app.get('/auth/login', async (_req, reply) => {
    reply.type('text/html').send(shell('Đăng nhập', `
      <div id="msg" class="msg"></div>
      <form id="f">
        <label>Email</label>
        <input name="email" type="email" required autocomplete="email">
        <label>Mật khẩu</label>
        <input name="password" type="password" required autocomplete="current-password">
        <button type="submit" id="btn">Đăng nhập</button>
      </form>
      <div class="alt"><a href="/auth/forgot">Quên mật khẩu?</a> · <a href="/auth/signup">Đăng ký</a></div>
      <script>
      // Surface ?msg= from verify/etc redirects
      (function(){
        var m = getQS('msg');
        if (m === 'verified')              showMsg('ok',   '✅ Đã xác thực email — đăng nhập để tiếp tục.');
        else if (m === 'verified_pending') showMsg('info', '✅ Đã xác thực email. Tài khoản đang chờ admin duyệt — bạn sẽ nhận email khi được duyệt và có thể đăng nhập.');
        else if (m === 'approved')         showMsg('ok',   '🎉 Tài khoản đã được duyệt! Đăng nhập để tiếp tục.');
        else if (m === 'reset_ok')         showMsg('ok',   '✅ Mật khẩu đã được đặt lại.');
        else if (m === 'used')             showMsg('err',  '❌ Link này đã được sử dụng.');
        else if (m === 'expired')          showMsg('err',  '❌ Link đã hết hạn — yêu cầu link mới.');
        else if (m === 'invalid_token')    showMsg('err',  '❌ Link không hợp lệ.');
      })();
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = '⏳ Đang đăng nhập…';
        var data = Object.fromEntries(new FormData(e.target));
        try {
          var r = await fetch('/auth/login', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data), credentials: 'same-origin' });
          var j = await r.json();
          if (j.ok) { location.href = '/'; }
          else {
            if (j.error === 'email_not_verified') {
              showMsg('err', '❌ Cần xác thực email trước. <a href="#" id="rv" style="color:#7ea7ff;">Gửi lại email xác thực</a>');
              document.getElementById('rv').onclick = async (e2) => {
                e2.preventDefault();
                await fetch('/auth/resend-verification', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ email: data.email }) });
                showMsg('ok', '✅ Đã gửi lại email xác thực.');
              };
            } else if (j.error === 'pending_approval') {
              showMsg('info', '⏳ Tài khoản đang chờ admin duyệt. Bạn sẽ nhận email khi được duyệt.');
            } else {
              showMsg('err', '❌ ' + (j.message || 'Đăng nhập thất bại'));
            }
            btn.disabled = false; btn.textContent = 'Đăng nhập';
          }
        } catch (err) {
          showMsg('err', '❌ Lỗi mạng: ' + err.message);
          btn.disabled = false; btn.textContent = 'Đăng nhập';
        }
      });
      </script>
    `));
  });

  // ---- FORGOT ----
  app.get('/auth/forgot', async (_req, reply) => {
    reply.type('text/html').send(shell('Quên mật khẩu', `
      <div id="msg" class="msg"></div>
      <form id="f">
        <label>Email tài khoản</label>
        <input name="email" type="email" required autocomplete="email">
        <button type="submit" id="btn">Gửi link đặt lại</button>
      </form>
      <div class="alt"><a href="/auth/login">← Quay lại đăng nhập</a></div>
      <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = '⏳ Đang gửi…';
        var data = Object.fromEntries(new FormData(e.target));
        await fetch('/auth/forgot', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data) });
        showMsg('ok', '✅ Nếu email tồn tại, link đặt lại đã được gửi. Kiểm tra hộp thư.');
        btn.textContent = 'Đã gửi';
      });
      </script>
    `));
  });

  // ---- RESET ----
  app.get<{ Querystring: { t?: string } }>('/auth/reset', async (req, reply) => {
    const token = req.query.t ?? '';
    reply.type('text/html').send(shell('Đặt mật khẩu mới', `
      <div id="msg" class="msg"></div>
      <form id="f">
        <input type="hidden" name="token" value="${esc(token)}">
        <label>Mật khẩu mới</label>
        <input name="password" type="password" required minlength="8" autocomplete="new-password">
        <div class="hint">Ít nhất 8 ký tự</div>
        <button type="submit" id="btn">Đặt mật khẩu</button>
      </form>
      <div class="alt"><a href="/auth/login">← Đăng nhập</a></div>
      <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = '⏳ Đang xử lý…';
        var data = Object.fromEntries(new FormData(e.target));
        var r = await fetch('/auth/reset', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data) });
        var j = await r.json();
        if (j.ok) { location.href = '/auth/login?msg=reset_ok'; }
        else { showMsg('err', '❌ ' + (j.message || j.error || 'Lỗi')); btn.disabled = false; btn.textContent = 'Đặt mật khẩu'; }
      });
      </script>
    `));
  });
}
