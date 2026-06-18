/**
 * Auth UI: signup / login / verify / forgot / reset.
 * Standalone HTML pages (not part of the app shell), styled to the nextclaw
 * "The Catch" system: ink navy + lime signal accent, Space Grotesk / Inter / Space Mono.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · nextclaw</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#0E1430; --ink-2:#131A3B; --text:#EAEDF7; --muted:#9AA3C7; --noise:#525a82;
    --signal:#C2F24A; --signal-ink:#0E1430; --mint:#7CE3C4; --line:#242C57;
    --display:'Space Grotesk',ui-sans-serif,system-ui,sans-serif;
    --body:'Inter',ui-sans-serif,system-ui,sans-serif;
    --mono:'Space Mono',ui-monospace,monospace;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;}
  body{font-family:var(--body);background:var(--ink);color:var(--text);display:flex;align-items:center;justify-content:center;padding:20px;
    background-image:radial-gradient(800px 460px at 50% -10%, rgba(194,242,74,.08), transparent 60%);-webkit-font-smoothing:antialiased;}
  .card{background:var(--ink-2);border:1px solid var(--line);border-radius:16px;padding:32px;width:100%;max-width:400px;
    box-shadow:0 30px 80px -40px rgba(0,0,0,.7);}
  .brand{display:flex;align-items:center;gap:8px;font-family:var(--display);font-weight:700;font-size:17px;letter-spacing:-.02em;margin-bottom:4px;}
  .brand .mark{color:var(--signal);}
  .kicker{font-family:var(--mono);font-size:11px;letter-spacing:.05em;color:var(--noise);margin-bottom:22px;}
  h1{font-family:var(--display);font-weight:600;font-size:22px;letter-spacing:-.02em;margin:0 0 18px;}
  label{display:block;font-size:12px;color:var(--muted);margin:14px 0 6px;font-weight:500;}
  input{width:100%;background:var(--ink);color:var(--text);border:1px solid var(--line);border-radius:9px;padding:11px 13px;font-size:14px;font-family:inherit;}
  input::placeholder{color:var(--noise);}
  input:focus{outline:none;border-color:var(--signal);box-shadow:0 0 0 3px rgba(194,242,74,.12);}
  button{width:100%;background:var(--signal);color:var(--signal-ink);border:0;padding:12px;border-radius:10px;font-size:14px;font-weight:600;
    font-family:var(--body);margin-top:20px;cursor:pointer;transition:transform .12s ease,filter .15s;}
  button:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.04);}
  button:disabled{opacity:.55;cursor:not-allowed;}
  button:focus-visible{outline:2px solid var(--mint);outline-offset:2px;}
  .alt{font-size:13px;color:var(--muted);margin-top:20px;text-align:center;}
  .alt a{color:var(--mint);text-decoration:none;}
  .alt a:hover{text-decoration:underline;}
  .msg{padding:10px 13px;border-radius:9px;font-size:13px;margin-bottom:14px;display:none;line-height:1.45;}
  .msg.show{display:block;}
  .msg.ok{background:rgba(124,227,196,.1);color:var(--mint);border:1px solid rgba(124,227,196,.3);}
  .msg.err{background:rgba(255,120,130,.08);color:#ff9aa3;border:1px solid rgba(255,120,130,.25);}
  .msg.info{background:rgba(154,163,199,.08);color:var(--muted);border:1px solid var(--line);}
  .msg a{color:var(--mint);}
  .hint{font-size:11px;color:var(--noise);margin-top:5px;}
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
  <div class="brand"><span class="mark">&#9670;</span>nextclaw</div>
  <div class="kicker">// catch buyers from Facebook groups</div>
  <h1>${esc(title)}</h1>
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
    reply.type('text/html').send(shell('Create your account', `
      <div id="msg" class="msg"></div>
      <div class="hint" id="planHint" style="margin:0 0 12px;color:var(--mint);"></div>
      <form id="f">
        <label>Workspace name (optional)</label>
        <input name="tenant_name" placeholder="e.g. ACME Corp" maxlength="80">
        <div class="hint">Defaults to your email if left blank</div>
        <label>Email</label>
        <input name="email" type="email" required autocomplete="email">
        <label>Password</label>
        <input name="password" type="password" required minlength="8" autocomplete="new-password">
        <div class="hint">At least 8 characters</div>
        <button type="submit" id="btn">Create account</button>
      </form>
      <div class="alt">Already have an account? <a href="/auth/login">Log in</a></div>
      <script>
      (function(){ var p = getQS('plan'); if (p) { var el = document.getElementById('planHint'); if (el) el.textContent = 'Selected plan: ' + p; } })();
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = 'Working…';
        var data = Object.fromEntries(new FormData(e.target));
        data.plan = getQS('plan') || undefined;
        try {
          var r = await fetch('/auth/signup', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data) });
          var j = await r.json();
          if (j.ok) {
            showMsg('ok', 'Verification email sent to ' + data.email + '. After you verify, we\\'ll confirm your plan and payment, then activate your account and email you. Questions or ready to pay? support@nextclaw.vn');
            btn.textContent = 'Email sent';
          } else {
            showMsg('err', (j.message || j.error || 'Something went wrong'));
            btn.disabled = false; btn.textContent = 'Create account';
          }
        } catch (err) {
          showMsg('err', 'Network error: ' + err.message);
          btn.disabled = false; btn.textContent = 'Create account';
        }
      });
      </script>
    `));
  });

  // ---- LOGIN ----
  app.get('/auth/login', async (_req, reply) => {
    reply.type('text/html').send(shell('Log in', `
      <div id="msg" class="msg"></div>
      <form id="f">
        <label>Email</label>
        <input name="email" type="email" required autocomplete="email">
        <label>Password</label>
        <input name="password" type="password" required autocomplete="current-password">
        <button type="submit" id="btn">Log in</button>
      </form>
      <div class="alt"><a href="/auth/forgot">Forgot password?</a> &middot; <a href="/auth/signup">Sign up</a></div>
      <script>
      // Surface ?msg= from verify/etc redirects
      (function(){
        var m = getQS('msg');
        if (m === 'verified')              showMsg('ok',   'Email verified — log in to continue.');
        else if (m === 'verified_pending') showMsg('info', 'Email verified! We\\'ll activate your account once your payment is confirmed, then email you so you can log in. Ready to pay or have questions? support@nextclaw.vn');
        else if (m === 'approved')         showMsg('ok',   'Your account is active! Log in to continue.');
        else if (m === 'reset_ok')         showMsg('ok',   'Your password has been reset.');
        else if (m === 'used')             showMsg('err',  'This link has already been used.');
        else if (m === 'expired')          showMsg('err',  'This link has expired — request a new one.');
        else if (m === 'invalid_token')    showMsg('err',  'This link is invalid.');
      })();
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = 'Logging in…';
        var data = Object.fromEntries(new FormData(e.target));
        try {
          var r = await fetch('/auth/login', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data), credentials: 'same-origin' });
          var j = await r.json();
          if (j.ok) { location.href = '/'; }
          else {
            if (j.error === 'email_not_verified') {
              showMsg('err', 'Please verify your email first. <a href="#" id="rv">Resend verification email</a>');
              document.getElementById('rv').onclick = async (e2) => {
                e2.preventDefault();
                await fetch('/auth/resend-verification', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ email: data.email }) });
                showMsg('ok', 'Verification email resent.');
              };
            } else if (j.error === 'pending_approval') {
              showMsg('info', 'Your account is awaiting activation. We\\'ll switch it on once your payment is confirmed. Questions? support@nextclaw.vn');
            } else {
              showMsg('err', (j.message || 'Login failed'));
            }
            btn.disabled = false; btn.textContent = 'Log in';
          }
        } catch (err) {
          showMsg('err', 'Network error: ' + err.message);
          btn.disabled = false; btn.textContent = 'Log in';
        }
      });
      </script>
    `));
  });

  // ---- FORGOT ----
  app.get('/auth/forgot', async (_req, reply) => {
    reply.type('text/html').send(shell('Reset your password', `
      <div id="msg" class="msg"></div>
      <form id="f">
        <label>Account email</label>
        <input name="email" type="email" required autocomplete="email">
        <button type="submit" id="btn">Send reset link</button>
      </form>
      <div class="alt"><a href="/auth/login">&larr; Back to log in</a></div>
      <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = 'Sending…';
        var data = Object.fromEntries(new FormData(e.target));
        await fetch('/auth/forgot', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data) });
        showMsg('ok', 'If that email exists, a reset link is on its way. Check your inbox.');
        btn.textContent = 'Sent';
      });
      </script>
    `));
  });

  // ---- RESET ----
  app.get<{ Querystring: { t?: string } }>('/auth/reset', async (req, reply) => {
    const token = req.query.t ?? '';
    reply.type('text/html').send(shell('Set a new password', `
      <div id="msg" class="msg"></div>
      <form id="f">
        <input type="hidden" name="token" value="${esc(token)}">
        <label>New password</label>
        <input name="password" type="password" required minlength="8" autocomplete="new-password">
        <div class="hint">At least 8 characters</div>
        <button type="submit" id="btn">Set password</button>
      </form>
      <div class="alt"><a href="/auth/login">&larr; Log in</a></div>
      <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        var btn = document.getElementById('btn'); btn.disabled = true; btn.textContent = 'Working…';
        var data = Object.fromEntries(new FormData(e.target));
        var r = await fetch('/auth/reset', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data) });
        var j = await r.json();
        if (j.ok) { location.href = '/auth/login?msg=reset_ok'; }
        else { showMsg('err', (j.message || j.error || 'Something went wrong')); btn.disabled = false; btn.textContent = 'Set password'; }
      });
      </script>
    `));
  });
}
