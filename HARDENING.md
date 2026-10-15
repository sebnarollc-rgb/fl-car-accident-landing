# Production Hardening & Compliance

How this project addresses a standard production-readiness checklist. Scope: a
static marketing/landing page (served as static files / Vercel) plus a small
Express lead-intake API (`server/`) on a Hetzner VPS that emails leads and
appends them to `leads.csv`. There is **no login, no admin panel, and no
database** — several checklist items are N/A for that reason and are marked so.

Status legend: ✅ implemented · ⚙️ operational (run/configure on the VPS) · ▫️ N/A for this architecture

---

## Input sanitization & injection prevention — ✅
- All form fields pass through `clean()` (strips CR/LF, trims, length-caps) before use — `server/server.js`.
- Email HTML escapes every value with `esc()` (`& < > " '`) → no HTML/script injection in notifications.
- **CSV / Excel formula injection fixed:** cells beginning with `= + - @` (or tab/CR) are prefixed with `'` before writing `leads.csv`, so opening the file in Excel/Sheets can't execute a payload. Covered by a regression test.
- JSON body capped at 20 kb (`express.json({ limit: "20kb" })`).
- No SQL/templating engine → no SQLi/SSTI surface.

## HTTPS, TLS, certificate rotation — ⚙️
- `server/setup-https.sh` provisions nginx + Let's Encrypt (certbot) for `api.sealaccidentgroup.com`, additive to the existing CampusSublet config, `nginx -t`-guarded.
- **Rotation is automatic:** certbot installs a systemd renewal timer; certs renew ~30 days before expiry. Verify with `systemctl list-timers | grep certbot` and `certbot renew --dry-run`.
- HSTS sent by the API (`helmet`, 180 days) and by the static site (`dist/vercel.json`). Force-HTTPS redirect is configured by certbot (`--redirect`).

## Rate limiting & abuse prevention — ✅
- Strict per-form limiter: 5 POSTs / IP / 10 min on `/api/lead`.
- Coarse global limiter: 60 req / IP / min (DoS guard).
- Honeypot `company` field (bots fill it → silently accepted, not saved).
- Optional Cloudflare Turnstile (enforced only when `TURNSTILE_SECRET` is set; fail-open on network error so a Cloudflare outage never blocks real leads).
- `trust proxy` set so limits key off the real client IP behind nginx.

## Dependency scanning & vulnerability patching — ✅
- `.github/dependabot.yml` — weekly npm + github-actions update PRs.
- `.github/workflows/ci.yml` — runs tests **and** `npm audit --omit=dev --audit-level=high` on every push/PR.
- `npm run audit` for an on-demand check.
- Patched on setup: nodemailer `6.x → 9.0.1`, clearing a high-severity SMTP/header-injection advisory. Current audit: **0 vulnerabilities**.

## Secrets management — ✅⚙️
- All secrets in `server/.env` (never committed; `.gitignore` covers `.env`, `server/.env`, `leads.csv`).
- `deploy.sh` `chmod 600` on `.env` and `leads.csv`.
- Startup validation warns on missing SMTP and **hard-fails in production if `ALLOWED_ORIGINS` is empty** (prevents an accidentally world-open CORS deploy).
- Never stored in this repo or memory: Namecheap/SMTP/VPS passwords — Genaro holds those.
- Rotation: change the value in `.env`, then `pm2 restart lead-server`.

## PII handling, data retention & deletion — ✅⚙️
- Leads contain PII; `leads.csv` is `chmod 600`, never committed, and the audit log stores only name + **masked** phone.
- **Retention:** `server/scripts/retention-purge.js` deletes rows older than `RETENTION_DAYS` (default 730 / 2 yrs). Schedule via cron:
  `0 3 * * * cd /opt/lead-server && RETENTION_DAYS=730 node scripts/retention-purge.js >> /var/log/lead-retention.log 2>&1`
- **Deletion requests (CCPA/GDPR "right to erasure"):** locate the row(s) in `leads.csv` by name/phone/email and remove them; the purge above also enforces a hard ceiling. Document the request in the audit log.

## Unit, integration & end-to-end tests — ✅
- `server/test/server.test.js` (Node built-in runner, zero extra deps): unit (`clean`, `esc`), integration (`/health`, honeypot, validation, happy-path `/api/lead`, 404). Run with `npm test`. **8/8 passing.**

## Regression tests — ✅
- CSV formula-injection neutralization has a dedicated regression test.
- The "email send must never fail the request" contract is asserted (happy-path returns `ok:true, emailed:false` with no SMTP).
- Note: the prior mobile post-submit overlap bug was fixed by removing scroll-reveal (see launch notes); front-end is static so it's verified via Lighthouse + manual device check rather than a unit test.

## Code review process & standards — ✅
- CI gates merges on tests + audit. `pull_request` trigger means every PR is checked.
- Recommended: protect `main`, require the CI check + one review before merge (set in GitHub repo settings).

## Error handling & graceful degradation — ✅
- Lead is written to CSV **first**; email + auto-reply are best-effort and never fail the request (degrades gracefully if SMTP is down).
- Centralized Express error handler (no stack traces leaked to clients), JSON 404 handler.
- `SIGTERM`/`SIGINT` graceful shutdown (drains in-flight requests, 10 s force-kill fallback); `uncaughtException`/`unhandledRejection` handlers so pm2 restarts a clean process.

## Accessibility (WCAG) — ✅
- Form has real `<label for>` on every field, `aria-required`, `role="alert"` error regions, `role="status"` success region, decorative SVGs `aria-hidden`, visible focus, semantic landmarks (`nav`, `region` labels).
- Verify on each change with Lighthouse a11y + keyboard-only pass. The `web-design-guidelines` skill can audit the HTML.

## Caching strategy & invalidation — ✅
- `dist/vercel.json`: static assets (`css/js/png/svg/...`) `max-age=31536000, immutable`; **HTML `must-revalidate`** so content edits appear immediately (fixes the prior "CDN serves stale page" issue — no more `?cachebust`).
- API responses are not cached.

## Basic logging & monitoring — ✅⚙️
- Per-request access log line (method, path, status, latency, IP) to stdout → captured by `pm2 logs lead-server`.
- Append-only `audit.log` of lead events.
- `/health` returns `{ ok, uptime }` — point an uptime monitor (UptimeRobot / BetterStack / Hetzner) at `https://api.sealaccidentgroup.com/health`.

## Backup & recovery — ⚙️
- `server/scripts/backup-leads.sh`: GPG-AES256 encrypts `leads.csv` + `audit.log` and ships off-box (rclone remote or scp). PII is never backed up in plaintext. Cron:
  `30 3 * * * BACKUP_PASSPHRASE=… RCLONE_REMOTE=remote:lead-backups bash /opt/lead-server/scripts/backup-leads.sh`
- **Recovery:** `gpg --decrypt leads-backup-*.gpg > leads.tar.gz && tar -xzf leads.tar.gz`, restore into `/opt/lead-server`, `pm2 restart lead-server`.
- VPS infra is reproducible from `deploy.sh` + `setup-https.sh`.

## Authentication, authorization, roles & permissions — ▫️
- No login, admin UI, or user accounts exist, so there is nothing to authenticate. If a leads dashboard/export endpoint is ever added, gate it behind auth (e.g. Basic auth over HTTPS or an SSO proxy) and never expose `leads.csv` over the public web. Server-side, `ALLOWED_ORIGINS` (CORS) restricts who may POST.

## Session management & token expiry — ▫️
- No sessions/tokens (stateless single endpoint). The only token is the per-request Turnstile token, validated server-side and not persisted.

## Regulatory compliance (GDPR/CCPA) — ✅⚙️
- `privacy.html` + `terms.html` published (pending attorney review).
- **TCPA consent** captured and stored: form sends `consent` + exact `consent_text` + timestamp; logged to `leads.csv` and the lead email.
- Erasure/retention handled by the retention purge + manual deletion process above.
- TODO before launch: confirm CCPA "Do Not Sell/Share" + GDPR notices if targeting CA/EU; attorney/bar advertising review.

## Audit trails (sensitive/legal records) — ✅
- Append-only `server/audit.log`: one JSON line per lead event (`lead_received`, `retention_purge`) with timestamp, name, **masked** phone, consent flag, IP — enough to evidence a TCPA consent record without over-retaining PII.
- `leads.csv` itself is the full intake record (timestamp + IP per row). Include both in the encrypted off-server backup.

---

## Deploy these changes
The hardened code lives in `server/`. To push to the VPS (from your Mac, where your SSH key is):

```bash
# 1) copy the updated server files up (excludes node_modules/.env/leads.csv)
rsync -avz --exclude node_modules --exclude .env --exclude 'leads.csv' --exclude 'audit.log' \
  "server/" root@YOUR_VPS_IP:/opt/lead-server/

# 2) install + restart on the box
ssh root@YOUR_VPS_IP 'cd /opt/lead-server && npm install --omit=dev && pm2 restart lead-server && pm2 save'

# 3) verify
ssh root@YOUR_VPS_IP 'curl -s http://127.0.0.1:3001/health'
```
This does **not** touch the co-located CampusSublet/PocketBase stack.
