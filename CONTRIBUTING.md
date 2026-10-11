# Contributing

Thanks for your interest! Bug reports and pull requests are welcome.

- **Language**: user-facing text is US English only (UI, API messages, public pages).
- **Branding**: nothing brand-specific belongs in the source; names and logos are configured in *Settings*.
- **Tests**: run the stack with `docker compose up -d --build` against a *fresh* database and execute `./smoke.sh http://127.0.0.1:3100`. Add checks for new behavior.
- **Types**: `cd web && npm install && npm run typecheck`; the server is type-checked by `npm run build`.
- **Security issues**: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
- By contributing you agree that your contribution is licensed under the project's license (AGPL-3.0-or-later).
