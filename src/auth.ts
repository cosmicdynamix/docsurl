import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { ipHash, randomToken, sha256 } from './crypto.js';
import { clientIp, secureCookie } from './net.js';
import { pool } from './db.js';

export const SESSION_COOKIE = 'docs_session';
export const CSRF_COOKIE = 'docs_csrf';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  theme: 'dark' | 'light' | 'system';
  mustChangePassword: boolean;
  totpEnabled: boolean;
  totpRequired: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  theme: 'dark' | 'light' | 'system';
  must_change_password: boolean;
  totp_enabled: boolean;
  totp_required: boolean;
}

export function toSessionUser(r: UserRow): SessionUser {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    theme: r.theme,
    mustChangePassword: r.must_change_password,
    totpEnabled: r.totp_enabled,
    totpRequired: r.totp_required,
  };
}

export async function loadSessionUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query<UserRow>(
    `select u.id, u.email, u.display_name, u.role, u.theme, u.must_change_password, u.totp_enabled, u.totp_required
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.is_active`,
    [sha256(token)],
  );
  return rows[0] ? toSessionUser(rows[0]) : null;
}

export async function createSession(userId: string, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await pool.query(
    'insert into sessions(user_id, token_hash, expires_at, ip_hash, ua) values ($1,$2,$3,$4,$5)',
    [userId, sha256(token), expires, ipHash(clientIp(req)), (req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(req),
    expires,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await pool.query('delete from sessions where token_hash = $1', [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function destroyUserSessions(userId: string, exceptToken?: string): Promise<void> {
  if (exceptToken) {
    await pool.query('delete from sessions where user_id = $1 and token_hash <> $2', [userId, sha256(exceptToken)]);
  } else {
    await pool.query('delete from sessions where user_id = $1', [userId]);
  }
}

export async function audit(
  req: FastifyRequest,
  action: string,
  targetType?: string,
  targetId?: string,
  detail?: Record<string, unknown>,
  userId?: string,
): Promise<void> {
  await pool.query(
    'insert into audit_log(user_id, action, target_type, target_id, detail, ip_hash) values ($1,$2,$3,$4,$5,$6)',
    [userId ?? req.user?.id ?? null, action, targetType ?? null, targetId ?? null, detail ?? null, ipHash(clientIp(req))],
  );
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) return void reply.code(401).send({ error: 'unauthorized' });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) return void reply.code(401).send({ error: 'unauthorized' });
  if (req.user.role !== 'admin') return void reply.code(403).send({ error: 'forbidden' });
}
