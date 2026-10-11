import type { FastifyRequest } from 'fastify';
import { config } from './config.js';

/**
 * The visitor's IP address. By default Fastify's `req.ip` (which honors TRUST_PROXY).
 * Set CLIENT_IP_HEADER (e.g. "cf-connecting-ip") ONLY when every request is guaranteed to come
 * through that proxy, otherwise clients could spoof it.
 */
export function clientIp(req: FastifyRequest): string {
  const h = config.clientIpHeader;
  if (h) {
    const v = req.headers[h];
    if (typeof v === 'string' && v) return v.split(',')[0].trim().slice(0, 64);
  }
  return req.ip;
}

/** Use the Secure cookie flag whenever the connection (as seen through the proxy) is HTTPS. */
export function secureCookie(req: FastifyRequest): boolean {
  return config.cookieSecure || req.protocol === 'https';
}

/** Keep in-memory throttle tables from growing without bound. */
export function purgeExpired(map: Map<string, { until: number }>, maxSize = 2000): void {
  if (map.size <= maxSize) return;
  const now = Date.now();
  for (const [k, v] of map) if (v.until < now) map.delete(k);
}
