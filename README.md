# Seal Accident Group: Landing Page and Lead Intake

A fast, bilingual (English and Spanish) landing page for Seal Accident Group, a Miami car accident referral service, plus the Node.js backend that captures and routes every lead.

**Live:** [sealaccidentgroup.com](https://sealaccidentgroup.com)
**Built by:** [Sebnaro LLC](https://sebnaro.com), 2026

## The page

- Mobile-first, with click-to-call and a sticky call bar on phones
- One-tap English/Spanish toggle across all copy, form labels and messages
- Short lead form with inline validation, a honeypot and optional Cloudflare Turnstile spam protection
- TCPA consent captured with the exact consent text the visitor saw
- Cookie consent banner, privacy policy and terms pages
- Security headers and a strict Content-Security-Policy set in `vercel.json`
- SEO basics: sitemap, robots.txt, Open Graph image
- Plain HTML, CSS and JavaScript. No framework, no build step

## The lead server (`server/`)

Node.js and Express, run under pm2 behind nginx with Let's Encrypt.

- **Hardening:** helmet, CORS allowlist, global rate limit plus a tighter limit on the lead endpoint
- **Compliance record:** consent timestamp set by the server, not trusted from the browser
- **Audit trail:** append-only log of lead events with phone numbers masked
- **Routing:** emails the intake team and sends the visitor an auto-reply; optional instant alerts by Telegram or SMS (Twilio)
- **Data hygiene:** leads file is never committed, plus scripts for encrypted backups and retention purges
- **Tests:** `node --test` suite, run in GitHub Actions on every push along with `npm audit`; Dependabot keeps dependencies current

See [`HARDENING.md`](HARDENING.md) for the full production checklist.

## Layout

```
index-v3.html     Source of the live page
dist/             Deployed bundle (page, legal pages, vercel.json)
demo/             Sales demo for a fictional firm, "Gulfline Injury Law"
server/           Lead intake API, deploy and HTTPS setup scripts, tests
```

`index.html` and `index-v2.html` are earlier iterations, kept for reference.

## Deploying

```bash
# Page
cd dist && npx vercel --prod

# Lead server
cd server && cp .env.example .env   # fill in values
./deploy.sh
```
