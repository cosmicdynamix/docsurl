# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the version/commit. You will get an acknowledgement and we will work with you on a fix and a coordinated disclosure.

## Supported versions

Only the latest commit on the default branch receives security fixes.

## Scope notes

DOCSurl stores access-controlled documents, so we are especially interested in:
authentication/authorization bypass, access to another user's links or statistics, access to a page image or original PDF without a valid link/token, stored XSS (titles, recipients, logos), SSRF/path traversal in uploads, and secrets exposure.

Known and documented limitations (not vulnerabilities): the view-only viewer cannot prevent screenshots or photographs; the first-run setup screen is open until the first admin exists (set `SETUP_TOKEN` to restrict it); visitors are identified by a browser cookie.

## Hardening checklist for operators

- Set `SETUP_TOKEN`, a strong `APP_SECRET` (`openssl rand -hex 32`) and a strong database password.
- Serve only over HTTPS; never expose the app container or PostgreSQL directly.
- Set `CLIENT_IP_HEADER` / `TRUST_PROXY` only to match your actual proxy chain.
- Apply container memory/CPU limits (PDF conversion handles untrusted files).
- Back up the database and the data volume; keep them private.
- Keep the images up to date (`docker compose pull && docker compose up -d --build`).
