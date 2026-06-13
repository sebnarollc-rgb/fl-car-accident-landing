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
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy if you run behind nginx/caddy (needed for correct rate-limit IPs)
app.set("trust proxy", 1);

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
        <tr><td><b>Name</b></td><td>${lead.name}</td></tr>
        <tr><td><b>Phone</b></td><td><a href="tel:${lead.phone}">${lead.phone}</a></td></tr>
        <tr><td><b>Email</b></td><td>${lead.email || "—"}</td></tr>
        <tr><td><b>When</b></td><td>${lead.accident_when || "—"}</td></tr>
        <tr><td><b>Injured</b></td><td>${lead.injured || "—"}</td></tr>
        <tr><td><b>Details</b></td><td>${lead.details || "—"}</td></tr>
        <tr><td><b>Page</b></td><td>${lead.page}</td></tr>
        <tr><td><b>Time</b></td><td>${lead.submitted_at}</td></tr>
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
