# Design

This document describes how DOCSurl works and why. For setup and configuration see the [README](README.md).

## 1. Goals and non-goals

**Goals**
1. Share a PDF through one **stable link** that survives file replacement.
2. Let the owner see **who** viewed it, **how** (device, source) and **how deeply** (time, pages).
3. Show documents **view-only**: the visitor never receives the PDF or a download link.
4. Be easy to self-host (one container + PostgreSQL), mobile-first, and brandable.

**Non-goals**
- DRM. A viewer can always screenshot or photograph a screen; the design aims at deterrence and traceability.
- Real-time dashboards or push notifications.
- Multi-tenant SaaS features (organizations, billing).

## 2. Architecture

```
Browser ──▶ reverse proxy (TLS) ──▶ app (Fastify, one container) ──▶ PostgreSQL
                                          │
                                          └──▶ DATA_DIR volume: originals, page images, logos
```

| Area | Routes | Notes |
|---|---|---|
| Panel (React SPA) | `/app/*` | Strict CSP (`script-src 'self'`), served as static files |
| Panel API | `/api/*` | Session cookie + CSRF (Origin check and double-submit token) |
| Public links | `/<slug>`, `/<slug>/unlock` | Server-rendered HTML; no JavaScript framework |
| Page images | `/_p/<link>/<version>/<n>?e=&t=` | HMAC-signed, 1 hour lifetime |
| Preview image | `/_og/<slug>.jpg` | Small first page for chat-app link cards; never stamped; hidden for password links |
| Engagement beacon | `POST /_t/<viewId>` | HMAC token per view |
| Branding | `GET /api/branding`, `/brand/logo/{dark,light}`, `/brand/icon/{180,192,512}`, `/manifest.webmanifest` | Public (needed on the sign-in and viewer pages) |

Slugs that collide with application paths are reserved (`app`, `api`, `health`, `brand`, …).

## 3. Rendering pipeline

1. Upload (multipart, streamed to a temp file while hashing) → magic-byte check (`%PDF-`) → `pdfinfo` (rejects encrypted PDFs, enforces `MAX_PAGES`).
2. `pdftoppm` renders each page with its long side scaled to 1800 px (JPEG, or PNG when a stamp must be applied so the image is compressed only once).
3. **Stamp** (if the link has a recipient and stamping is on): `sharp` composites a rounded light-gray box (`#E5E7EB`) with bold red text (`#C62828`), `Confidential — for <recipient>`, into the top-right corner. Size scales with page width; the text uses DejaVu Sans so non-ASCII names render.
4. Pages are stored under `DATA_DIR/docs/<linkId>/v<n>/pages/<page>.jpg`; the original stays next to them as `original.pdf`.
5. A version can hold a second PDF rendered the same way into `v<n>/mobile/`. The viewer picks the variant on the server: phones (by user-agent) get `mobile` when it exists, everything else gets `desktop`; `?view=mobile|desktop` overrides. Versions carry unchanged variants over from the live version when only one file is replaced.
6. Changing the recipient or the stamp setting re-renders **all** versions from the stored originals (rendered into `pages.new`, then swapped in).

The viewer is a plain HTML page with a small inline script (nonce-based CSP): pages are lazy-loaded images, right-click and dragging are disabled, printing is blocked. None of this stops a determined person; it removes the casual "save as".

## 4. Data model (PostgreSQL)

- `users` – role (`admin`/`user`), Argon2id hash, optional TOTP secret (AES-256-GCM encrypted) with replay guard, theme, forced-change flag
- `sessions` – hashed tokens, expiry; `audit_log` – admin and security events
- `links` – slug, kind (`file`/`url`), title, **recipient**, tags, stamp flag, password hash, expiry, view limit, current version
- `link_versions` – stored versions; `version_files` – up to two PDFs per version (`desktop`, which is also the default for every device, and an optional `mobile`); `link_pages` – page dimensions per variant
- `views` – one row per visit (see below); `view_pages` – cumulative active time per page and visit
- `settings` – system name, logo and app-icon file names

## 5. Analytics definitions

A **view** is one load of a link's page. By default these are excluded from every number: requests from known bots/link-preview fetchers and views by the link's owner or an admin (both can be included with a toggle).

| Metric | Definition |
|---|---|
| Unique visitor | Distinct first-party cookie (`docs_vid`); falls back to the hashed IP when cookies are blocked |
| Returning visitor | A visitor with more than one view in the selected range |
| **Active time** | Time the tab was visible **and** the visitor interacted within the last 120 s |
| Open time | Wall-clock time the page stayed open |
| Layout | The variant (`desktop`/`mobile`) that served the visit; page numbers, depth and *completed* refer to that variant's page count |
| Deepest page | Highest page that crossed the middle of the screen |
| Time per page | Active time attributed to the page in view |
| Completed | Deepest page ≥ page count |
| Source | `?src=` tag, else referrer host (grouped into names like LinkedIn), else in-app browser hint, else *Direct / unknown* |

The viewer sends **cumulative totals** every 10 s and on page hide (`sendBeacon`). The server keeps the maximum of each value, so lost, repeated or out-of-order beacons are harmless. Location comes from Cloudflare headers; the app never looks IPs up itself and stores only a salted hash of the address.

## 6. Security design

- **Authentication**: Argon2id; throttled sign-in; fresh session on every login; sessions stored hashed, 30-day sliding lifetime (each visit restarts it; password changes and disabling a user end other sessions); optional TOTP with replay protection; admins force a password change on created accounts.
- **CSRF**: same-origin `Origin` check plus a double-submit token; `SameSite=Lax` cookies; `Secure` and HSTS when behind HTTPS.
- **Authorization**: users only reach their own links; every link route re-checks ownership (admins excepted); stats and exports use the same check.
- **Uploads**: type check by content, size/page limits, `pdftoppm` run with a timeout and no shell; logos are re-encoded (raster) or strictly validated (SVG: no scripts, event handlers, external references or `foreignObject`) and served with a sandbox CSP.
- **Public pages**: nonce-based CSP, escaped output only, signed image URLs, per-link unlock throttle, identical *not found* responses for missing/expired/disabled links.
- **Output hygiene**: CSV exports neutralize spreadsheet formulas; errors never include stack traces.
- **Secrets**: `APP_SECRET` encrypts TOTP seeds and signs tokens; keep it out of version control.

## 7. Theming and branding

Two themes (dark/light) driven by CSS custom properties; the choice is stored per user. The system name and the two logos (one for dark backgrounds, one for light) are stored in the database/volume and edited in **Settings**; nothing brand-specific lives in the source. Public pages use the same logos.

## 8. Possible next steps

API keys for automation, folders, webhooks, additional file types, localization of the UI.
