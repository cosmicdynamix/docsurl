import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  audit,
  createSession,
  destroySession,
  destroyUserSessions,
  requireAuth,
} from '../auth.js';
import { getBranding, setSetting } from '../branding.js';
import { config } from '../config.js';
import { clientIp, purgeExpired } from '../net.js';
import { verifyTotp } from '../totp.js';
import { siteNameSchema } from './settings.js';
import { signatureSchema } from '../signature.js';
import { encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { DUMMY_HASH, hashPassword, passwordSchema, verifyPassword } from '../passwords.js';

const emailSchema = z.string().trim().toLowerCase().email().max(200);

// In-memory login throttle: 5 failures / 15 min per ip+email.
const fails = new Map<string, { n: number; until: number }>();
function throttled(key: string): boolean {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() > f.until) {
    fails.delete(key);
    return false;
  }
  return f.n >= 5;
}
function registerFail(key: string): void {
  purgeExpired(fails);
  const f = fails.get(key);
  if (!f || Date.now() > f.until) fails.set(key, { n: 1, until: Date.now() + 15 * 60_000 });
  else f.n++;
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/setup/status', async () => {
    const { rows } = await pool.query('select count(*)::int as n from users');
    return { needsSetup: rows[0].n === 0, tokenRequired: !!config.setupToken };
  });

  app.post('/api/setup', async (req, reply) => {
    const body = z
      .object({
        email: emailSchema,
        displayName: z.string().trim().min(1).max(100),
        password: passwordSchema,
        token: z.string().optional(),
        siteName: siteNameSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() });
    if (config.setupToken && body.data.token !== config.setupToken)
      return reply.code(403).send({ error: 'bad_setup_token' });

    const pw = await hashPassword(body.data.password);
    // Insert only if there are no users yet (atomic).
    const { rows } = await pool.query<{ id: string }>(
      `insert into users(email, display_name, role, password_hash)
       select $1, $2, 'admin', $3 where not exists (select 1 from users) returning id`,
      [body.data.email, body.data.displayName, pw],
    );
    if (!rows[0]) return reply.code(409).send({ error: 'already_set_up' });
    if (body.data.siteName) await setSetting('site_name', body.data.siteName);
    await audit(req, 'setup.admin_created', 'user', rows[0].id, undefined, rows[0].id);
    await createSession(rows[0].id, req, reply);
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    const body = z
      .object({ email: emailSchema, password: z.string().min(1).max(200), totp: z.string().trim().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const key = `${clientIp(req)}|${body.data.email}`;
    if (throttled(key)) return reply.code(429).send({ error: 'too_many_attempts' });

    const { rows } = await pool.query(
      'select id, password_hash, is_active, totp_enabled, totp_secret_enc from users where email = $1',
      [body.data.email],
    );
    const u = rows[0];
    const ok = await verifyPassword(u?.password_hash ?? DUMMY_HASH, body.data.password);
    if (!u || !ok || !u.is_active) {
      registerFail(key);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (u.totp_enabled) {
      if (!body.data.totp) return reply.code(401).send({ error: 'totp_required' });
      const valid = await verifyTotp(u.id, u.totp_secret_enc, body.data.totp);
      if (!valid) {
        registerFail(key);
        return reply.code(401).send({ error: 'invalid_totp' });
      }
    }
    fails.delete(key);
    await pool.query('update users set last_login_at = now() where id = $1', [u.id]);
    await createSession(u.id, req, reply);
    await audit(req, 'login', 'user', u.id, undefined, u.id);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ user: req.user, siteName: getBranding().siteName }));

  app.patch('/api/me', { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(100).optional(),
        theme: z.enum(['dark', 'light', 'system']).optional(),
        signature: signatureSchema.optional(), // null clears it
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    await pool.query(
      'update users set display_name = coalesce($2, display_name), theme = coalesce($3, theme) where id = $1',
      [req.user!.id, body.data.displayName ?? null, body.data.theme ?? null],
    );
    if (body.data.signature !== undefined)
      await pool.query('update users set signature = $2 where id = $1', [
        req.user!.id,
        body.data.signature ? JSON.stringify(body.data.signature) : null,
      ]);
    return { ok: true };
  });

  app.post('/api/me/password', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ current: z.string().min(1), next: passwordSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() });
    const { rows } = await pool.query('select password_hash from users where id = $1', [req.user!.id]);
    if (!(await verifyPassword(rows[0].password_hash, body.data.current)))
      return reply.code(403).send({ error: 'wrong_current_password' });
    if (body.data.current === body.data.next) return reply.code(400).send({ error: 'same_password' });
    await pool.query('update users set password_hash = $2, must_change_password = false where id = $1', [
      req.user!.id,
      await hashPassword(body.data.next),
    ]);
    // Log out every other session of this user.
    await destroyUserSessions(req.user!.id, req.cookies[SESSION_COOKIE]);
    await audit(req, 'password.changed', 'user', req.user!.id);
    return { ok: true };
  });

  // ---- 2FA (TOTP), optional for everyone ----
  app.post('/api/me/2fa/setup', { preHandler: requireAuth }, async (req, reply) => {
    if (req.user!.totpEnabled) return reply.code(409).send({ error: 'already_enabled' });
    const secret = authenticator.generateSecret();
    await pool.query('update users set totp_secret_enc = $2 where id = $1', [req.user!.id, encrypt(secret)]);
    const uri = authenticator.keyuri(req.user!.email, getBranding().siteName, secret);
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });

  app.post('/api/me/2fa/enable', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ code: z.string().trim().min(6).max(10) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const { rows } = await pool.query('select totp_secret_enc from users where id = $1', [req.user!.id]);
    if (!rows[0]?.totp_secret_enc) return reply.code(409).send({ error: 'no_setup' });
    if (!(await verifyTotp(req.user!.id, rows[0].totp_secret_enc, body.data.code)))
      return reply.code(400).send({ error: 'invalid_totp' });
    await pool.query('update users set totp_enabled = true where id = $1', [req.user!.id]);
    await audit(req, '2fa.enabled', 'user', req.user!.id);
    return { ok: true };
  });

  app.post('/api/me/2fa/disable', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ password: z.string().min(1), code: z.string().trim().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    if (req.user!.totpRequired) return reply.code(403).send({ error: '2fa_required_by_admin' });
    const { rows } = await pool.query('select password_hash, totp_secret_enc, totp_enabled from users where id = $1', [
      req.user!.id,
    ]);
    const u = rows[0];
    if (!(await verifyPassword(u.password_hash, body.data.password)))
      return reply.code(403).send({ error: 'wrong_current_password' });
    if (u.totp_enabled) {
      if (!body.data.code || !(await verifyTotp(req.user!.id, u.totp_secret_enc, body.data.code)))
        return reply.code(400).send({ error: 'invalid_totp' });
    }
    await pool.query('update users set totp_enabled = false, totp_secret_enc = null where id = $1', [req.user!.id]);
    await audit(req, '2fa.disabled', 'user', req.user!.id);
    return { ok: true };
  });
}
