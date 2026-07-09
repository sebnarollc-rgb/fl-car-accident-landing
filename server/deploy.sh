#!/usr/bin/env bash
# =====================================================================
# One-shot deploy for the FL attorney lead-intake backend (Hetzner VPS)
# Fresh Ubuntu. Run as root:   sudo bash deploy.sh
# Installs Node 20, app deps, runs under pm2, enables firewall.
# Listens on 127.0.0.1:3001 ONLY (no public port) until a domain +
# reverse proxy (Caddy) are added later. Safe to re-run (idempotent).
# =====================================================================
set -euo pipefail

APP_DIR=/opt/lead-server
PORT=3001

echo "==> [1/7] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

echo "==> [2/7] Installing Node.js 20 LTS + tools..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y ufw curl ca-certificates

echo "==> [3/7] Writing application files to ${APP_DIR}..."
mkdir -p "$APP_DIR"

# The canonical, hardened source for server.js/package.json is the repo
# `server/` dir, deployed via rsync (see HARDENING.md). These embedded copies
# are only a fresh-box bootstrap — do NOT clobber an existing deployment, which
# may be newer/hardened. Only write them when server.js is absent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "$APP_DIR/server.js" ]; then
  echo "    (server.js already present — leaving deployed copy untouched; use rsync to update code)"
elif [ -f "$SCRIPT_DIR/server.js" ] && [ "$SCRIPT_DIR" != "$APP_DIR" ]; then
  # Prefer the canonical, hardened repo copy sitting next to this script over
  # the stale embedded bootstrap below.
  echo "    (copying repo server.js/package.json from $SCRIPT_DIR)"
  cp "$SCRIPT_DIR/server.js" "$SCRIPT_DIR/package.json" "$APP_DIR/"
  [ -f "$SCRIPT_DIR/package-lock.json" ] && cp "$SCRIPT_DIR/package-lock.json" "$APP_DIR/"
else

cat > "$APP_DIR/package.json" <<'PKGEOF'
{
  "name": "fl-car-accident-lead-server",
  "version": "1.0.0",
  "description": "Lead intake backend for the FL car accident attorney landing page",
  "main": "server.js",
  "type": "commonjs",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "helmet": "^7.1.0",
    "nodemailer": "^9.0.1"
  }
}
PKGEOF

cat > "$APP_DIR/server.js" <<'SRVEOF'
/* =========================================================
   Lead intake backend for the FL Car Accident landing page.
   Runs on your VPS. Receives the form POST, emails the lead,
   and appends it to a CSV as a backup.

   Quick start on your VPS:
     1) cp .env.example .env   and fill in the values
     2) npm install
     3) node server.js         (or use pm2 / systemd — see README)

   The landing page posts JSON to:  POST /api/lead
   ========================================================= */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy if you run behind nginx/caddy (needed for correct rate-limit IPs)
app.set("trust proxy", 1);

// Secure HTTP headers
app.use(helmet());

app.use(express.json({ limit: "20kb" }));

// Only allow your own site(s) to post. Comma-separated list in .env
const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  }
}));

// Throttle abuse: max 5 submissions per IP per 10 minutes
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

// Email transport (SMTP) — works with any provider (Gmail app password, SES, Mailgun, etc.)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

function clean(v, max = 2000) {
  return String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

// Escape values before putting them in the HTML email (prevents HTML/script injection)
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CSV_PATH = path.join(__dirname, "leads.csv");
function appendCsv(row) {
  const header = "timestamp,name,phone,email,accident_when,injured,details,page,ip\n";
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, header);
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  fs.appendFileSync(CSV_PATH, [
    row.submitted_at, row.name, row.phone, row.email,
    row.accident_when, row.injured, row.details, row.page, row.ip
  ].map(esc).join(",") + "\n");
}

app.post("/api/lead", limiter, async (req, res) => {
  try {
    const b = req.body || {};

    // Honeypot — bots fill this; humans never see it
    if (b.company) return res.status(200).json({ ok: true });

    const lead = {
      name: clean(b.name, 120),
      phone: clean(b.phone, 40),
      email: clean(b.email, 160),
      accident_when: clean(b.accident_when, 60),
      injured: clean(b.injured, 60),
      details: clean(b.details, 2000),
      page: clean(b.page, 300),
      submitted_at: clean(b.submitted_at, 40) || new Date().toISOString(),
      ip: clean(req.ip, 60)
    };

    if (lead.name.length < 2 || lead.phone.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ ok: false, error: "Name and a valid phone are required." });
    }

    // Backup to CSV first (so a lead is never lost even if email fails)
    try { appendCsv(lead); } catch (e) { console.error("CSV write failed:", e.message); }

    // Email the intake team
    const html = `
      <h2>New car accident lead</h2>
      <table cellpadding="6" style="border-collapse:collapse">
        <tr><td><b>Name</b></td><td>${esc(lead.name)}</td></tr>
        <tr><td><b>Phone</b></td><td><a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a></td></tr>
        <tr><td><b>Email</b></td><td>${esc(lead.email) || "—"}</td></tr>
        <tr><td><b>When</b></td><td>${esc(lead.accident_when) || "—"}</td></tr>
        <tr><td><b>Injured</b></td><td>${esc(lead.injured) || "—"}</td></tr>
        <tr><td><b>Details</b></td><td>${esc(lead.details) || "—"}</td></tr>
        <tr><td><b>Page</b></td><td>${esc(lead.page)}</td></tr>
        <tr><td><b>Time</b></td><td>${esc(lead.submitted_at)}</td></tr>
      </table>`;

    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.LEAD_TO,
      replyTo: lead.email || undefined,
      subject: `🚗 New lead: ${lead.name} (${lead.phone})`,
      html,
      text: `New lead\nName: ${lead.name}\nPhone: ${lead.phone}\nEmail: ${lead.email}\nWhen: ${lead.accident_when}\nInjured: ${lead.injured}\nDetails: ${lead.details}\nPage: ${lead.page}\nTime: ${lead.submitted_at}`
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Lead error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Lead server listening on :${PORT}`));
SRVEOF

fi  # end fresh-box bootstrap guard

# Write .env only if it does not already exist (never clobber real secrets)
if [ ! -f "$APP_DIR/.env" ]; then
cat > "$APP_DIR/.env" <<'ENVEOF'
# Copy to .env and fill in. NEVER commit the real .env file.

PORT=3001

# Comma-separated list of sites allowed to POST to this server
ALLOWED_ORIGINS=https://your-landing-domain.com,https://www.your-landing-domain.com

# Where new leads get emailed
LEAD_TO=intake@yourfirm.com
MAIL_FROM="Lead Bot <no-reply@yourfirm.com>"

# SMTP credentials (Gmail app password, Amazon SES, Mailgun, Postmark, etc.)
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
ENVEOF
  echo "    (placeholder .env written — edit it with real SMTP + recipient later)"
else
  echo "    (.env already present — left untouched)"
fi

echo "==> [4/7] Installing dependencies..."
cd "$APP_DIR"
npm install --omit=dev

echo "==> [5/7] Locking down sensitive files..."
chmod 600 "$APP_DIR/.env"
touch "$APP_DIR/leads.csv"
chmod 600 "$APP_DIR/leads.csv"

echo "==> [6/7] Starting under pm2 (auto-restart on reboot)..."
npm install -g pm2
pm2 start server.js --name lead-server 2>/dev/null || pm2 restart lead-server
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

echo "==> [7/7] Configuring firewall (SSH + 80/443 only; app stays internal)..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo
echo "==> Health check (local):"
sleep 2
curl -s "http://127.0.0.1:${PORT}/health" && echo " <- server is up" || echo "  (no response — check: pm2 logs lead-server)"

echo
echo "============================================================"
echo " DONE. Lead server is running on 127.0.0.1:${PORT}"
echo " It is intentionally NOT exposed publicly yet."
echo " Next steps (later): point a domain here, then add Caddy"
echo " as a reverse proxy with automatic HTTPS, and fill in .env."
echo " Useful: pm2 status | pm2 logs lead-server | nano /opt/lead-server/.env"
echo "============================================================"
