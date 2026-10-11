import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { CSRF_COOKIE, loadSessionUser } from './auth.js';
import { loadBranding } from './branding.js';
import { config } from './config.js';
import { randomToken } from './crypto.js';
import { migrate, pool, waitForDb } from './db.js';
import { clientIp, secureCookie } from './net.js';
import { linkRoutes } from './routes/links.js';
import { publicRoutes } from './routes/public.js';
import { sessionRoutes } from './routes/session.js';
import { settingsRoutes } from './routes/settings.js';
import { statsRoutes } from './routes/stats.js';
import { userRoutes } from './routes/users.js';
import { ensureStorage } from './storage.js';

const app = Fastify({ logger: { level: 'info' }, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 });

// JSON bodies may be empty (logout, reset actions); sendBeacon posts JSON as text/plain.
for (const type of ['application/json', 'text/plain']) {
  app.addContentTypeParser(type, { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });
}

await app.register(cookie);
await app.register(formbody);
await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 20, fieldSize: 4096 } });
await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: (req) => clientIp(req) });

app.decorateRequest('user', null);

// Never leak internals: 4xx keep a generic code, everything else becomes a plain 500.
app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal_error' });
  }
  const error = err.code === 'FST_REQ_FILE_TOO_LARGE' ? 'file_too_large' : status === 429 ? 'too_many_requests' : 'bad_request';
  return reply.code(status).send({ error });
});

// Paths a user may call while a forced password change is pending.
const ALLOWED_WHEN_MUST_CHANGE = new Set(['/api/me', '/api/me/password', '/api/logout', '/api/health', '/api/branding', '/api/setup/status']);

app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  const urlPath = req.url.split('?')[0];
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  // Cross-site request protection, layer 1: a browser-supplied Origin must match our host.
  if (unsafe && typeof req.headers.origin === 'string') {
    let ok = false;
    try {
      ok = new URL(req.headers.origin).host === req.headers.host;
    } catch {
      /* malformed origin */
    }
    if (!ok) return reply.code(403).send({ error: 'bad_origin' });
  }

  // Layer 2 (double submit): the CSRF cookie must be echoed in a header on unsafe methods.
  let csrf = req.cookies[CSRF_COOKIE];
  if (!csrf) {
    csrf = randomToken(24);
    reply.setCookie(CSRF_COOKIE, csrf, { path: '/', sameSite: 'lax', secure: secureCookie(req), httpOnly: false });
  } else if (unsafe && req.headers['x-csrf-token'] !== csrf) {
    return reply.code(403).send({ error: 'bad_csrf' });
  }

  req.user = await loadSessionUser(req);
  if (req.user?.mustChangePassword && !ALLOWED_WHEN_MUST_CHANGE.has(urlPath)) {
    return reply.code(403).send({ error: 'must_change_password' });
  }
});

app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
});

app.get('/health', async () => ({ ok: true }));
await app.register(sessionRoutes);
await app.register(userRoutes);
await app.register(linkRoutes);
await app.register(statsRoutes);
await app.register(settingsRoutes);

// Panel (React SPA) under /app
const PANEL_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const webDir = path.resolve(config.webDir);
if (existsSync(webDir)) {
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/app/',
    wildcard: false,
    maxAge: '1h',
    setHeaders: (reply) => {
      reply.header('Content-Security-Policy', PANEL_CSP);
    },
  });
  app.get('/app', async (_req, reply) => reply.redirect('/app/'));
  app.get('/app/*', async (_req, reply) => reply.sendFile('index.html'));
} else {
  app.log.warn(`web dir ${webDir} not found; panel not served`);
}
app.get('/', async (_req, reply) => reply.redirect('/app/'));
// Public link routes (/:slug ...) last: static routes above take precedence.
await app.register(publicRoutes);

await ensureStorage();
await waitForDb();
await migrate();
await loadBranding();
// Expired sessions cleanup, hourly
setInterval(() => void pool.query('delete from sessions where expires_at < now()').catch(() => {}), 3600_000).unref();

await app.listen({ port: config.port, host: config.host });
