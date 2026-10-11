# DOCSurl

Self-hosted document sharing with **stable links**, a **view-only viewer** and **detailed per-visitor analytics**.

Upload a PDF, share one link, and see who opened it, from where, for how long, how far they read and which page held their attention. Replace the file later and the link (and its history) stay the same.

> Licensed under the **GNU AGPL v3 or later**. See [LICENSE](LICENSE).

## Features

**Sharing**
- PDF upload → a stable link `https://your.host/<slug>`; replace the file any time, the link and stats stay
- Optional **password**, **expiry date** and **view limit**, set at upload or later
- **File versions**: every upload is kept; roll back with one click; stats are available per version
- **Recipient stamp**: a light-gray box with red text, `Confidential — for <name>`, burned into the top-right corner of every page (per-link toggle)
- **Short URL mode**: shorten any http(s) address with the same options and statistics
- QR code per link, link-preview cards (Open Graph) for chat apps, tags and search

**View-only viewer**
- Pages are rendered to images on the server; the original PDF and any download link are **never sent** to the visitor
- Image URLs are signed and short-lived; mobile-first, pinch-to-zoom, page indicator

**Analytics** (excluding bots/link previews and your own views by default)
- Views, unique/returning visitors, **active time vs. time open**, deepest page reached, **time per page**
- Country/city (via Cloudflare headers), browser, OS, device, language, **referrer**, in-app browser, `?src=` tags
- Per-**visitor** pages and per-**version** pages, visit list, CSV export, overview across all links

**Accounts**
- Roles: **admin** (everything, audit log) and **user** (own links only)
- Admins create users and reset passwords/2FA; users change their own password
- Optional **TOTP 2FA** (replay-protected), forced password change on first sign-in
- Light/dark themes, English UI, **bring your own branding** (system name and logos are uploaded in *Settings*)

## Quick start

Requirements: Docker with Compose.

```bash
git clone https://github.com/cosmicdynamix/docsurl.git && cd docsurl
cp .env.example .env
# fill in POSTGRES_PASSWORD and APP_SECRET (see the comments in .env.example)
docker compose up -d --build
```

Open `http://localhost:3100/app/`. The first visit shows the **setup screen**: choose a system name and create the admin account. Then open **Settings** to upload your logos.

> **Before exposing it to the internet** set `SETUP_TOKEN` (so only you can finish the first-run setup), serve it over **HTTPS** behind a reverse proxy, and read [Running in production](#running-in-production).

## Configuration

All settings are environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | – (required) | PostgreSQL connection string (the compose file builds it for you) |
| `APP_SECRET` | – (required) | 64 hex chars. Encrypts 2FA secrets and signs links/tokens. `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | – (compose) | Database password. Avoid `$` in secrets (Compose interpolates it) |
| `SETUP_TOKEN` | empty | If set, required on the first-run setup screen |
| `COOKIE_SECURE` | `false` | Force the `Secure` cookie flag. It is also set automatically when the proxy reports HTTPS |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Proxies trusted for `X-Forwarded-*` (`true`, `false` or a comma list) |
| `CLIENT_IP_HEADER` | empty | Header with the real client IP, e.g. `cf-connecting-ip`. Set **only** if all traffic comes through that proxy |
| `DATA_DIR` | `/data` | Uploads, rendered pages and logos (mount a volume) |
| `MAX_UPLOAD_MB` | `100` | Maximum PDF size |
| `MAX_PAGES` | `300` | Maximum pages per PDF |
| `SESSION_DAYS` | `30` | Sign-in lifetime. It is a sliding window: every visit restarts it, so active users stay signed in |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address inside the container |

## Running in production

- **HTTPS**: terminate TLS at a reverse proxy (Traefik, Caddy, nginx, Cloudflare Tunnel…) and forward `X-Forwarded-Proto`/`Host`. The app then sets `Secure` cookies and HSTS automatically.
- **Location data**: the app reads Cloudflare's visitor-location headers (`CF-IPCountry`, `CF-IPCity`, …). Enable *Rules → Managed Transforms → Add visitor location headers* in Cloudflare and set `CLIENT_IP_HEADER=cf-connecting-ip`. Without Cloudflare, location fields stay empty.
- **Do not expose the container directly** if you set `CLIENT_IP_HEADER` or `TRUST_PROXY=true`: clients could spoof their IP.
- **Resource limits**: PDF conversion runs `pdftoppm` on untrusted files. Run the container with memory/CPU limits (`mem_limit`, `cpus`) and as the default non-root user.
- **Backups**: back up the PostgreSQL database *and* the `DATA_DIR` volume (originals are kept there so pages can be re-rendered).
- **Updates**: `git pull && docker compose up -d --build`. Migrations run automatically at start.

## What data is collected

For each view of a link the app stores: time, a **hashed** IP (never the raw address), user-agent and its parsed parts, referrer, `?src=` tag, language, screen size, country/city when Cloudflare headers are present, active/open time and per-page time, and a random first-party **visitor cookie** (`docs_vid`, 1 year) used to count unique/returning visitors. No third-party scripts, fonts or trackers are loaded. Depending on where you and your visitors are, you may need to disclose this (e.g. under GDPR/ePrivacy); that is your responsibility as the operator.

## Limits to be aware of

- **View-only is a deterrent, not DRM.** Anything shown on a screen can be photographed or captured. The stamp makes leaks traceable; it does not prevent them.
- Visitors are told apart by a browser cookie: the same person on two devices counts twice.
- PDF only (up to `MAX_PAGES`); encrypted PDFs are rejected; text in pages is not selectable (pages are images).
- No outgoing email: passwords are reset by an admin, not by email.
- Single-instance design (in-memory throttles); put one app instance behind your proxy.

## Development

```bash
docker compose up -d --build        # app on :3100
./smoke.sh http://127.0.0.1:3100    # end-to-end API checks (needs a FRESH database; creates test users)
```

- Backend: Node 22, Fastify 5, PostgreSQL 16, plain SQL migrations in `migrations/`
- Panel: React 18 + Vite in `web/` (pure SVG charts, no UI/chart library)
- PDF → images: `poppler-utils`; stamping: `sharp`
- See [DESIGN.md](DESIGN.md) for the architecture and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

> `smoke.sh` truncates nothing itself but assumes an empty database (it performs the first-run setup). Never run it against a database holding real data.

## License

GNU Affero General Public License v3.0 or later — see [LICENSE](LICENSE). If you run a modified version as a network service you must offer its source code to the users of that service.

## Deploying on Coolify

1. **New Resource → Public Repository** → `https://github.com/cosmicdynamix/docsurl`, branch `main`, build pack **Docker Compose**, compose file `/docker-compose.coolify.yml`.
2. Set the **domain** on the `app` service (container port `3000`).
3. Add the environment variables `APP_SECRET` (`openssl rand -hex 32`) and `SETUP_TOKEN` (any long random value). Behind Cloudflare also set `CLIENT_IP_HEADER=cf-connecting-ip`.
4. Deploy, open `https://your-domain/app/`, finish the setup with your `SETUP_TOKEN`, then upload your logos in **Settings**.
5. Add backups for the `docs-pgdata` and `docs-files` volumes.
