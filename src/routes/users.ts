import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, destroyUserSessions, requireAdmin } from '../auth.js';
import { generatePassword } from '../crypto.js';
import { linkDir, removeDir } from '../storage.js';
import { pool } from '../db.js';
import { hashPassword, passwordSchema } from '../passwords.js';

const emailSchema = z.string().trim().toLowerCase().email().max(200);
const idParam = z.object({ id: z.string().uuid() });

async function activeAdminCount(): Promise<number> {
  const { rows } = await pool.query("select count(*)::int as n from users where role = 'admin' and is_active");
  return rows[0].n;
}

const USER_COLS = `id, email, display_name as "displayName", role, is_active as "isActive",
  must_change_password as "mustChangePassword", totp_enabled as "totpEnabled", totp_required as "totpRequired",
  created_at as "createdAt", last_login_at as "lastLoginAt"`;

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', { preHandler: requireAdmin }, async () => {
    const { rows } = await pool.query(`select ${USER_COLS} from users order by created_at`);
    return { users: rows };
  });

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const body = z
      .object({
        email: emailSchema,
        displayName: z.string().trim().min(1).max(100),
        role: z.enum(['admin', 'user']).default('user'),
        password: passwordSchema.optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', details: body.error.flatten() });
    const temp = body.data.password ?? generatePassword();
    try {
      const { rows } = await pool.query(
        `insert into users(email, display_name, role, password_hash, must_change_password, created_by)
         values ($1,$2,$3,$4,true,$5) returning ${USER_COLS}`,
        [body.data.email, body.data.displayName, body.data.role, await hashPassword(temp), req.user!.id],
      );
      await audit(req, 'user.created', 'user', rows[0].id, { email: body.data.email, role: body.data.role });
      // Temporary password is shown ONCE; the user must change it at first login.
      return { user: rows[0], tempPassword: temp };
    } catch (e: unknown) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email_exists' });
      throw e;
    }
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(100).optional(),
        role: z.enum(['admin', 'user']).optional(),
        isActive: z.boolean().optional(),
        totpRequired: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid' });
    const id = p.data.id;

    const cur = (await pool.query('select role, is_active from users where id = $1', [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });

    const losingAdmin =
      cur.role === 'admin' &&
      cur.is_active &&
      ((body.data.role && body.data.role !== 'admin') || body.data.isActive === false);
    if (losingAdmin && (await activeAdminCount()) <= 1) return reply.code(409).send({ error: 'last_admin' });
    if (id === req.user!.id && body.data.isActive === false) return reply.code(409).send({ error: 'cannot_disable_self' });

    await pool.query(
      `update users set display_name = coalesce($2, display_name), role = coalesce($3, role),
              is_active = coalesce($4, is_active), totp_required = coalesce($5, totp_required) where id = $1`,
      [id, body.data.displayName ?? null, body.data.role ?? null, body.data.isActive ?? null, body.data.totpRequired ?? null],
    );
    if (body.data.isActive === false) await destroyUserSessions(id);
    await audit(req, 'user.updated', 'user', id, body.data);
    return { ok: true };
  });

  app.post('/api/users/:id/reset-password', { preHandler: requireAdmin }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const temp = generatePassword();
    const { rowCount } = await pool.query('update users set password_hash = $2, must_change_password = true where id = $1', [
      p.data.id,
      await hashPassword(temp),
    ]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    await destroyUserSessions(p.data.id);
    await audit(req, 'user.password_reset', 'user', p.data.id);
    return { tempPassword: temp };
  });

  app.post('/api/users/:id/reset-2fa', { preHandler: requireAdmin }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    const { rowCount } = await pool.query('update users set totp_enabled = false, totp_secret_enc = null where id = $1', [
      p.data.id,
    ]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(req, 'user.2fa_reset', 'user', p.data.id);
    return { ok: true };
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid' });
    if (p.data.id === req.user!.id) return reply.code(409).send({ error: 'cannot_delete_self' });
    const cur = (await pool.query('select role, is_active, email from users where id = $1', [p.data.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.role === 'admin' && cur.is_active && (await activeAdminCount()) <= 1)
      return reply.code(409).send({ error: 'last_admin' });
    const owned = (await pool.query<{ id: string }>('select id from links where owner_id = $1', [p.data.id])).rows;
    await pool.query('delete from users where id = $1', [p.data.id]);
    for (const l of owned) await removeDir(linkDir(l.id)); // links cascade in the DB; remove their files too
    await audit(req, 'user.deleted', 'user', p.data.id, { email: cur.email });
    return { ok: true };
  });

  app.get('/api/audit', { preHandler: requireAdmin }, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100) || 100, 500);
    const { rows } = await pool.query(
      `select a.id, a.action, a.target_type as "targetType", a.target_id as "targetId", a.detail, a.at,
              u.email as "actorEmail"
         from audit_log a left join users u on u.id = a.user_id order by a.id desc limit $1`,
      [limit],
    );
    return { entries: rows };
  });
}
