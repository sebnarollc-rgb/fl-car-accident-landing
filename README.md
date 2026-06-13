# Florida Car Accident — Attorney Connect Landing Page

A fast, mobile-first landing page that connects Florida car accident victims with an attorney as quickly as possible. Built as static HTML/CSS/JS (no build step) with a small Node.js backend for lead intake.

## What's here

```
.
├── index.html          # The landing page
├── styles.css          # Design system (Trust & Authority: navy + gold)
├── script.js           # Form validation, async submit, CTA tracking
├── server/             # VPS lead-intake backend (Node/Express)
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── .gitignore
└── README.md
```

## Conversion features

- **Click-to-call** everywhere (`tel:` links) — sticky bottom bar on mobile with Call + Text.
- **Lead form** with inline validation, honeypot anti-spam, and a clear success state.
- **SMS/text CTA** (`sms:` link) for quick contact.
- Florida-specific trust content: PIP 14-day rule, statute of limitations, what-to-do-now steps, FAQ.
- Accessible (WCAG-minded), responsive at 375/768/1024/1440px, respects reduced motion.

## Before going live — replace these placeholders

Search and replace across `index.html` (and `script.js` for the error fallback):

| Placeholder | Replace with |
|-------------|--------------|
| `[FIRM NAME]` | Your firm's name |
| `[PHONE]` | Phone number (used in `tel:` and `sms:` — use a plain number like `+18005551234` for the links) |
| `[EMAIL]` | Contact email |
| `[ADDRESS]` | Office address |
| `YOUR-VPS-DOMAIN.com` | Your backend domain (the form `action` in `index.html`) |

Also update the stats strip and testimonials with your firm's **real, verified** numbers and reviews. The bar/legal language is attorney advertising boilerplate — have your firm review it.

## Deploy the landing page

It's fully static. Host the root folder anywhere:

- **Netlify / Cloudflare Pages / GitHub Pages** — drag-and-drop or connect the repo.
- **Your VPS** — serve the root with nginx/Caddy.

## Deploy the lead backend (your VPS)

```bash
cd server
cp .env.example .env        # fill in SMTP + recipient + allowed origins
npm install
npm start                   # or run under pm2 / systemd (below)
```

Point the form `action` in `index.html` at `https://your-vps-domain.com/api/lead`.

**Run it persistently with pm2:**
```bash
npm install -g pm2
pm2 start server.js --name lead-server
pm2 save && pm2 startup
```

**Reverse proxy (nginx) example:**
```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Leads are emailed to `LEAD_TO` and also appended to `server/leads.csv` as a backup (gitignored — it contains client PII, never commit it).

## Lead handling & compliance notes

- The form collects consent to be contacted. Keep that checkbox.
- `leads.csv` and `.env` contain sensitive data and are gitignored. Secure your VPS accordingly.
- This page is attorney advertising. Confirm all claims, disclaimers, and bar-compliance language with the firm before launch.

## License

Proprietary — for the firm's use. Update as needed.
