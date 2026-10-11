function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: required('DATABASE_URL'),
  // 64 hex chars (32 bytes): encrypts TOTP secrets, salts IP hashes
  appSecret: required('APP_SECRET'),
  // Set to "true" behind HTTPS (Cloudflare/Traefik). False on plain-HTTP dev.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // Which proxies to trust for X-Forwarded-*: "true", "false" or a comma list of addresses/aliases.
  trustProxy: ((v: string): boolean | string[] => (v === 'true' ? true : v === 'false' ? false : v.split(',').map((s) => s.trim()).filter(Boolean)))(
    process.env.TRUST_PROXY ?? 'loopback,linklocal,uniquelocal',
  ),
  // Optional header carrying the real client IP (e.g. cf-connecting-ip). Only set when ALL traffic goes through that proxy.
  clientIpHeader: (process.env.CLIENT_IP_HEADER ?? '').toLowerCase() || null,
  // Optional: if set, first-run setup requires this token
  setupToken: process.env.SETUP_TOKEN || null,
  dataDir: process.env.DATA_DIR ?? '/data',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 100),
  maxPages: Number(process.env.MAX_PAGES ?? 300),
  sessionDays: Number(process.env.SESSION_DAYS ?? 14),
  webDir: process.env.WEB_DIR ?? 'web-dist',
  migrationsDir: process.env.MIGRATIONS_DIR ?? 'migrations',
};

if (!/^[0-9a-f]{64}$/i.test(config.appSecret)) {
  throw new Error('APP_SECRET must be 64 hex characters (32 bytes)');
}
