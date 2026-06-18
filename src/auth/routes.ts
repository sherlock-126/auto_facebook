/**
 * /auth/* routes: signup, login, logout, verify email, password reset.
 * Rate-limited (5 req/min/IP) on every mutation endpoint via per-route config.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db.js';
import { signSession, issueToken, consumeToken } from './tokens.js';
import { hashPassword, verifyPassword, validatePassword } from './passwords.js';
import { createUserAndTenant, findUserByEmail, markEmailVerified, updatePassword, recordLogin } from './users.js';
import { setSessionCookie, clearSessionCookie, requireAuth, isAdminEmail } from './middleware.js';
import { sendEmail } from '../email/resend-client.js';
import { verifyEmailTemplate, passwordResetTemplate } from '../email/templates.js';

const RL = { rateLimit: { max: 5, timeWindow: '1 minute' } } as const;

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ---- SIGNUP ----
  app.post<{ Body: { email: string; password: string; tenant_name?: string } }>(
    '/auth/signup',
    { config: RL as any },
    async (req, reply) => {
      const { email, password, tenant_name } = req.body ?? {} as any;
      if (!email || !password) return reply.status(400).send({ error: 'missing_fields' });
      try {
        validatePassword(password);
        const user = await createUserAndTenant({ email, password, tenant_name });

        const token = await issueToken(user.user_id, 'verify_email');
        const tpl = verifyEmailTemplate({ email: user.email, token });
        await sendEmail({ to: user.email, subject: tpl.subject, html: tpl.html });

        return { ok: true, email_sent: true, tenant_id: user.tenant_id };
      } catch (e: any) {
        return reply.status(400).send({ error: 'signup_failed', message: e?.message ?? String(e) });
      }
    }
  );

  // ---- LOGIN ----
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    { config: RL as any },
    async (req, reply) => {
      const { email, password } = req.body ?? {} as any;
      if (!email || !password) return reply.status(400).send({ error: 'missing_fields' });
      const u = await findUserByEmail(email);
      if (!u) return reply.status(401).send({ error: 'invalid_credentials', message: 'Wrong email or password' });
      const ok = await verifyPassword(password, u.password_hash);
      if (!ok) return reply.status(401).send({ error: 'invalid_credentials', message: 'Wrong email or password' });
      if (!u.email_verified_at) {
        return reply.status(403).send({ error: 'email_not_verified', message: 'Please verify your email before logging in' });
      }
      if (!u.approved_at) {
        return reply.status(403).send({
          error: 'pending_approval',
          message: 'Your account is awaiting activation. We will email you once it is switched on.',
        });
      }
      const jwt = await signSession({ sub: u.user_id, tid: u.tenant_id, role: u.role, email: u.email });
      setSessionCookie(reply, jwt);
      await recordLogin(u.user_id);
      return { ok: true, tenant_id: u.tenant_id, email: u.email, role: u.role };
    }
  );

  // ---- ADMIN LOGIN (separate page on admin.nextclaw.vn) ----
  // Admins/staff skip the customer activation (approved_at) gate. Only emails in
  // ADMIN_EMAILS may use this; a verified email + correct password is enough.
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/admin-login',
    { config: RL as any },
    async (req, reply) => {
      const { email, password } = req.body ?? {} as any;
      if (!email || !password) return reply.status(400).send({ error: 'missing_fields' });
      if (!isAdminEmail(email)) return reply.status(403).send({ error: 'not_admin', message: 'Not an administrator account' });
      const u = await findUserByEmail(email);
      if (!u) return reply.status(401).send({ error: 'invalid_credentials', message: 'Wrong email or password' });
      const ok = await verifyPassword(password, u.password_hash);
      if (!ok) return reply.status(401).send({ error: 'invalid_credentials', message: 'Wrong email or password' });
      if (!u.email_verified_at) return reply.status(403).send({ error: 'email_not_verified', message: 'Please verify your email first' });
      const jwt = await signSession({ sub: u.user_id, tid: u.tenant_id, role: u.role, email: u.email });
      setSessionCookie(reply, jwt);
      await recordLogin(u.user_id);
      return { ok: true };
    }
  );

  // ---- LOGOUT ----
  app.post('/auth/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ---- VERIFY EMAIL (GET — clicked from email) ----
  // After email verify, the user enters "pending approval" state. Welcome email
  // (with license + install command) is NOT sent here — it goes out only when
  // admin approves the account via /api/admin/users/:id/approve.
  app.get<{ Querystring: { t?: string } }>('/auth/verify', async (req, reply) => {
    const token = req.query.t;
    if (!token) return reply.redirect('/auth/login?msg=invalid_token');
    const result = await consumeToken(token, 'verify_email');
    if (!result.ok || !result.user_id) {
      return reply.redirect(`/auth/login?msg=${result.reason ?? 'invalid_token'}`);
    }
    await markEmailVerified(result.user_id);
    return reply.redirect('/auth/login?msg=verified_pending');
  });

  // ---- RESEND VERIFICATION ----
  app.post<{ Body: { email: string } }>(
    '/auth/resend-verification',
    { config: RL as any },
    async (req, reply) => {
      const { email } = req.body ?? {} as any;
      if (!email) return reply.status(400).send({ error: 'missing_email' });
      const u = await findUserByEmail(email);
      // Always return ok to avoid email enumeration
      if (!u || u.email_verified_at) return { ok: true, sent: false };
      const token = await issueToken(u.user_id, 'verify_email');
      const tpl = verifyEmailTemplate({ email: u.email, token });
      await sendEmail({ to: u.email, subject: tpl.subject, html: tpl.html });
      return { ok: true, sent: true };
    }
  );

  // ---- FORGOT PASSWORD ----
  app.post<{ Body: { email: string } }>(
    '/auth/forgot',
    { config: RL as any },
    async (req, reply) => {
      const { email } = req.body ?? {} as any;
      if (!email) return reply.status(400).send({ error: 'missing_email' });
      const u = await findUserByEmail(email);
      // Always ok to avoid enumeration
      if (!u) return { ok: true, sent: false };
      const token = await issueToken(u.user_id, 'reset_password');
      const tpl = passwordResetTemplate({ email: u.email, token });
      await sendEmail({ to: u.email, subject: tpl.subject, html: tpl.html });
      return { ok: true, sent: true };
    }
  );

  // ---- RESET PASSWORD ----
  app.post<{ Body: { token: string; password: string } }>(
    '/auth/reset',
    { config: RL as any },
    async (req, reply) => {
      const { token, password } = req.body ?? {} as any;
      if (!token || !password) return reply.status(400).send({ error: 'missing_fields' });
      try {
        validatePassword(password);
      } catch (e: any) {
        return reply.status(400).send({ error: 'bad_password', message: e?.message });
      }
      const result = await consumeToken(token, 'reset_password');
      if (!result.ok || !result.user_id) {
        return reply.status(400).send({ error: 'invalid_or_expired_token', message: 'This reset link is invalid or has expired' });
      }
      const hash = await hashPassword(password);
      await updatePassword(result.user_id, hash);
      return { ok: true };
    }
  );

  // ---- CHANGE PASSWORD (authenticated) ----
  app.post<{ Body: { current_password: string; new_password: string } }>(
    '/auth/change-password',
    { preHandler: requireAuth, config: RL as any },
    async (req, reply) => {
      const { current_password, new_password } = req.body ?? {} as any;
      if (!current_password || !new_password) return reply.status(400).send({ error: 'missing_fields' });
      try { validatePassword(new_password); }
      catch (e: any) { return reply.status(400).send({ error: 'bad_password', message: e?.message }); }

      const { rows } = await pool.query('SELECT password_hash FROM users WHERE user_id = $1', [req.user_id!]);
      if (!rows[0]) return reply.status(404).send({ error: 'user_not_found' });
      const ok = await verifyPassword(current_password, rows[0].password_hash);
      if (!ok) return reply.status(401).send({ error: 'wrong_password', message: 'Current password is wrong' });
      const hash = await hashPassword(new_password);
      await updatePassword(req.user_id!, hash);
      return { ok: true };
    }
  );

  // ---- WHO AM I ----
  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.email, u.role, u.tenant_id, u.email_verified_at, u.last_login_at,
              t.name AS tenant_name, t.plan, t.license_key
         FROM users u JOIN tenants t USING (tenant_id)
        WHERE u.user_id = $1`,
      [req.user_id!]
    );
    return { ok: true, user: rows[0] ?? null };
  });
}
