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
const IS_PROD = process.env.NODE_ENV === "production";

/* ---- Startup config validation (fail loud, not silent) ----
   In production, refuse to start with obviously-broken config so a
   misconfigured deploy is caught immediately. In dev we only warn. */
(function validateConfig() {
  const problems = [];
  if (!(process.env.ALLOWED_ORIGINS || "").trim()) {
    problems.push("ALLOWED_ORIGINS is empty — CORS would accept ALL origins.");
  }
  if (!process.env.SMTP_HOST || !process.env.LEAD_TO) {
    problems.push("SMTP_HOST/LEAD_TO not set — lead emails will not send (CSV backup still works).");
  }
  if (problems.length) {
    console.warn("[config] " + problems.join("  "));
    // Open CORS in production is the one thing we hard-fail on.
    if (IS_PROD && !(process.env.ALLOWED_ORIGINS || "").trim()) {
      console.error("[config] Refusing to start in production with open CORS. Set ALLOWED_ORIGINS.");
      process.exit(1);
    }
  }
})();

// Trust proxy if you run behind nginx/caddy (needed for correct rate-limit IPs)
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Secure HTTP headers (incl. HSTS — takes effect once served over HTTPS)
app.use(helmet({ hsts: { maxAge: 15552000, includeSubDomains: true } }));

app.use(express.json({ limit: "20kb" }));

/* ---- Lightweight request + audit logging (no extra deps) ----
   access log: one line per request to stdout (captured by `pm2 logs`).
   audit log: append-only, PII-minimized record of lead events for legal
   traceability (name + masked phone only). */
const AUDIT_PATH = process.env.AUDIT_PATH || path.join(__dirname, "audit.log");
function audit(event, detail) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + "\n";
  try { fs.appendFileSync(AUDIT_PATH, line); } catch (e) { console.error("audit write failed:", e.message); }
}
function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 4 ? "***" + d.slice(-4) : "***";
}
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms ip=${req.ip}`);
  });
  next();
});

// Coarse global rate limit (abuse/DoS guard) on top of the strict per-form one
app.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));

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
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // Timeouts so a hung/unreachable SMTP server can't stall the request
  // for minutes (email is awaited inside the POST handler).
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000
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

const CSV_PATH = process.env.LEADS_CSV_PATH || path.join(__dirname, "leads.csv");
function appendCsv(row) {
  const header = "timestamp,name,phone,email,accident_when,injured,details,consent,consent_text,page,ip\n";
  if (!fs.existsSync(CSV_PATH) || fs.statSync(CSV_PATH).size === 0) fs.writeFileSync(CSV_PATH, header);
  // Neutralize CSV/Excel formula injection: a cell beginning with = + - @
  // (or tab/CR) is treated as a formula by spreadsheet apps. Prefix with '.
  const esc = s => {
    let str = String(s);
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return `"${str.replace(/"/g, '""')}"`;
  };
  fs.appendFileSync(CSV_PATH, [
    row.submitted_at, row.name, row.phone, row.email,
    row.accident_when, row.injured, row.details, row.consent, row.consent_text, row.page, row.ip
  ].map(esc).join(",") + "\n");
}

app.post("/api/lead", limiter, async (req, res) => {
  try {
    const b = req.body || {};

    // Honeypot — bots fill this; humans never see it
    if (b.company) return res.status(200).json({ ok: true });

    // Optional spam check via Cloudflare Turnstile (only enforced if secret is set)
    if (process.env.TURNSTILE_SECRET) {
      try {
        const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: process.env.TURNSTILE_SECRET,
            response: clean(b.turnstile_token, 4000),
            remoteip: req.ip
          }),
          // Don't let a slow Cloudflare response hang the submission —
          // the catch below fails open, same as a network error.
          signal: AbortSignal.timeout(6000)
        });
        const out = await r.json();
        if (!out.success) return res.status(400).json({ ok: false, error: "Verification failed. Please try again." });
      } catch (e) {
        console.error("Turnstile verify error (allowing through):", e.message);
      }
    }

    const lead = {
      name: clean(b.name, 120),
      phone: clean(b.phone, 40),
      email: clean(b.email, 160),
      accident_when: clean(b.accident_when, 60),
      injured: clean(b.injured, 60),
      details: clean(b.details, 2000),
      consent: (b.consent === true || ["true","yes","on","1"].includes(String(b.consent).toLowerCase())) ? "yes" : "no",
      consent_text: clean(b.consent_text, 600),
      page: clean(b.page, 300),
      // Timestamp is part of the TCPA consent record, so don't trust the
      // client blindly: accept their timestamp only if it parses and is
      // within 10 minutes of server time; otherwise use server time.
      submitted_at: (() => {
        const t = Date.parse(clean(b.submitted_at, 40));
        return (Number.isFinite(t) && Math.abs(Date.now() - t) <= 10 * 60 * 1000)
          ? new Date(t).toISOString()
          : new Date().toISOString();
      })(),
      ip: clean(req.ip, 60)
    };

    if (lead.name.length < 2 || lead.phone.replace(/\D/g, "").length < 10) {
      return res.status(400).json({ ok: false, error: "Name and a valid phone are required." });
    }

    // Backup to CSV first (so a lead is never lost even if email fails)
    try { appendCsv(lead); } catch (e) { console.error("CSV write failed:", e.message); }
    audit("lead_received", { name: lead.name, phone: maskPhone(lead.phone), consent: lead.consent, ip: lead.ip });

    // Build a polished, email-client-safe HTML notification (tables + inline styles).
    const FIRM_NAME_EM = process.env.FIRM_NAME || "Seal Accident Group";
    const digits = lead.phone.replace(/\D/g, "");
    let fmtDate;
    try { fmtDate = new Date(lead.submitted_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch (_) { fmtDate = lead.submitted_at; }
    const row = (label, val) => val ? `<tr>
        <td style="padding:11px 18px;border-top:1px solid #E7E0D0;color:#6F6757;font:13px Arial,Helvetica,sans-serif;width:150px;vertical-align:top">${label}</td>
        <td style="padding:11px 18px;border-top:1px solid #E7E0D0;color:#1C1A16;font:15px Arial,Helvetica,sans-serif;line-height:1.5">${val}</td>
      </tr>` : "";
    const html = `
    <div style="background:#ECE4D5;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#F3EEE4;border:1px solid #DCD3C0;border-radius:14px;overflow:hidden">
        <tr><td style="background:#1C1A16;padding:24px 30px">
          <div style="font-family:Georgia,'Times New Roman',serif;color:#F3EEE4;font-size:21px;font-weight:bold;letter-spacing:.3px">${esc(FIRM_NAME_EM)}</div>
          <div style="color:#C9A66B;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;margin-top:5px">New Case Review Request</div>
        </td></tr>
        <tr><td style="padding:26px 30px 6px">
          <div style="font-family:Georgia,serif;color:#1C1A16;font-size:24px;font-weight:bold">${esc(lead.name)}</div>
          <div style="margin-top:5px;color:#6F6757;font-size:13px">Submitted ${esc(fmtDate)}</div>
        </td></tr>
        <tr><td style="padding:14px 30px 22px">
          <a href="tel:${esc(digits)}" style="display:inline-block;background:#7E2B2B;color:#F3EEE4;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 24px;border-radius:999px;margin:0 8px 8px 0">Call ${esc(lead.phone)}</a>
          ${lead.email ? `<a href="mailto:${esc(lead.email)}" style="display:inline-block;background:transparent;color:#1C1A16;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 24px;border:1px solid #1C1A16;border-radius:999px;margin:0 0 8px 0">Email client</a>` : ""}
        </td></tr>
        <tr><td style="padding:0 30px 24px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #E7E0D0;border-radius:10px;overflow:hidden">
            ${row("Phone", `<a href="tel:${esc(digits)}" style="color:#7E2B2B;text-decoration:none;font-weight:bold">${esc(lead.phone)}</a>`)}
            ${row("Email", lead.email ? `<a href="mailto:${esc(lead.email)}" style="color:#7E2B2B;text-decoration:none">${esc(lead.email)}</a>` : "—")}
            ${row("When it happened", esc(lead.accident_when) || "—")}
            ${row("Anyone injured", esc(lead.injured) || "—")}
            ${row("What happened", esc(lead.details) || "—")}
          </table>
        </td></tr>
        <tr><td style="padding:0 30px 26px">
          <div style="background:#ECE4D5;border-left:3px solid #B0894C;padding:12px 16px;border-radius:0 8px 8px 0;color:#4A453C;font:12px Arial,Helvetica,sans-serif;line-height:1.6">
            <strong style="color:#1C1A16">Consent to contact:</strong> ${lead.consent === "yes" ? "Yes" : "No"} &mdash; &ldquo;${esc(lead.consent_text) || "—"}&rdquo;<br>
            <span style="color:#8A8273">Source: ${esc(lead.page) || "—"} &middot; IP ${esc(lead.ip)}</span>
          </div>
        </td></tr>
        <tr><td style="background:#1C1A16;padding:15px 30px;text-align:center">
          <span style="color:#9A9282;font:11px Arial,Helvetica,sans-serif">${esc(FIRM_NAME_EM)} &middot; Automated lead notification</span>
        </td></tr>
      </table>
    </div>`;

    // Email the intake team — best-effort. The lead is already saved to CSV,
    // so a missing/unconfigured SMTP must NOT cause the submission to fail.
    let emailed = false;
    try {
      await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: process.env.LEAD_TO,
        replyTo: lead.email || undefined,
        subject: `New case review — ${lead.name} · ${lead.phone}`,
        html,
        text: `NEW CASE REVIEW REQUEST — ${FIRM_NAME_EM}\n\nName: ${lead.name}\nPhone: ${lead.phone}\nEmail: ${lead.email || "—"}\nWhen it happened: ${lead.accident_when || "—"}\nAnyone injured: ${lead.injured || "—"}\nWhat happened: ${lead.details || "—"}\n\nConsent to contact: ${lead.consent === "yes" ? "Yes" : "No"} ("${lead.consent_text || "—"}")\nSubmitted: ${fmtDate}\nSource: ${lead.page || "—"} (IP ${lead.ip})`
      });
      emailed = true;
    } catch (e) {
      console.error("Email send failed (lead is still saved in leads.csv):", e.message);
    }

    // Auto-reply to the lead — best-effort, only if they gave a valid email.
    const FIRM = process.env.FIRM_NAME || "our office";
    const FIRM_PHONE = process.env.FIRM_PHONE || "";
    let autoReplied = false;
    if (lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
      const first = (lead.name.split(/\s+/)[0] || "there");
      const callLine = FIRM_PHONE ? ` If you need to talk right now, call ${esc(FIRM_PHONE)}.` : "";
      try {
        await transporter.sendMail({
          from: process.env.MAIL_FROM,
          to: lead.email,
          subject: `We received your request — ${FIRM}`,
          html: `
          <div style="background:#ECE4D5;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#F3EEE4;border:1px solid #DCD3C0;border-radius:14px;overflow:hidden">
              <tr><td style="background:#1C1A16;padding:24px 30px">
                <div style="font-family:Georgia,'Times New Roman',serif;color:#F3EEE4;font-size:21px;font-weight:bold">${esc(FIRM)}</div>
                <div style="color:#C9A66B;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;margin-top:5px">Request Received</div>
              </td></tr>
              <tr><td style="padding:26px 30px 4px">
                <div style="font-family:Georgia,serif;color:#1C1A16;font-size:23px;font-weight:bold">Thank you, ${esc(first)}.</div>
              </td></tr>
              <tr><td style="padding:10px 30px 4px;color:#4A453C;font:15px/1.6 Arial,Helvetica,sans-serif">
                We've received your request and a member of our team will reach out shortly &mdash; usually within minutes. There's no cost to talk, and you pay nothing unless we win.
              </td></tr>
              ${FIRM_PHONE ? `<tr><td style="padding:18px 30px 4px">
                <div style="color:#6F6757;font:13px Arial,Helvetica,sans-serif;margin-bottom:8px">Prefer to talk now? Call us anytime, day or night.</div>
                <a href="tel:${esc(FIRM_PHONE.replace(/\D/g, ""))}" style="display:inline-block;background:#7E2B2B;color:#F3EEE4;text-decoration:none;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:999px">Call ${esc(FIRM_PHONE)}</a>
              </td></tr>` : ""}
              <tr><td style="padding:20px 30px 4px">
                <div style="font-family:Georgia,serif;color:#1C1A16;font-size:16px;font-weight:bold;margin-bottom:8px">Your request</div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid #E7E0D0;border-radius:10px;overflow:hidden">
                  ${row("When it happened", esc(lead.accident_when) || "—")}
                  ${row("Anyone injured", esc(lead.injured) || "—")}
                  ${row("What happened", esc(lead.details) || "—")}
                </table>
              </td></tr>
              <tr><td style="padding:18px 30px 26px;color:#8A8273;font:12px/1.6 Arial,Helvetica,sans-serif">
                This message only confirms we received your inquiry. It is general information, not legal advice, and does not create an attorney-client relationship. If this is a medical emergency, call 911.
              </td></tr>
              <tr><td style="background:#1C1A16;padding:15px 30px;text-align:center">
                <span style="color:#9A9282;font:11px Arial,Helvetica,sans-serif">${esc(FIRM)}${FIRM_PHONE ? " &middot; " + esc(FIRM_PHONE) : ""}</span>
              </td></tr>
            </table>
          </div>`,
          text: `Thank you, ${first}.\n\nWe've received your request and a member of our team will reach out shortly — usually within minutes. There's no cost to talk, and you pay nothing unless we win.${FIRM_PHONE ? `\n\nPrefer to talk now? Call us anytime: ${FIRM_PHONE}.` : ""}\n\nYour request:\n- When it happened: ${lead.accident_when || "—"}\n- Anyone injured: ${lead.injured || "—"}\n- What happened: ${lead.details || "—"}\n\nThis message only confirms we received your inquiry. It is not legal advice and does not create an attorney-client relationship. If this is a medical emergency, call 911.\n\n— ${FIRM}`
        });
        autoReplied = true;
      } catch (e) {
        console.error("Auto-reply failed (intake unaffected):", e.message);
      }
    }

    res.json({ ok: true, emailed, autoReplied });
  } catch (err) {
    console.error("Lead error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 404 for unknown routes
app.use((_req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// Centralized error handler — never leak stack traces to clients
app.use((err, _req, res, _next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }
  // Body-parser errors (malformed JSON, oversized payload) are the client's
  // fault — answer 4xx, not 500.
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "Request too large" });
  }
  if (err && (err.type === "entity.parse.failed" || (err.status >= 400 && err.status < 500))) {
    return res.status(err.status || 400).json({ ok: false, error: "Invalid request body" });
  }
  console.error("Unhandled error:", err && err.stack ? err.stack : err);
  res.status(500).json({ ok: false, error: "Server error" });
});

// Export the app so tests can drive it without binding a port.
module.exports = app;
// Expose pure helpers for unit tests (no side effects).
module.exports.__test = { clean, esc, maskPhone, appendCsv, CSV_PATH };

// Only start listening when run directly (not when imported by a test).
if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Lead server listening on :${PORT}`));

  // Graceful shutdown so pm2 restarts/reboots don't drop in-flight requests.
  function shutdown(signal) {
    console.log(`${signal} received — shutting down gracefully...`);
    server.close(() => { console.log("HTTP server closed."); process.exit(0); });
    setTimeout(() => { console.error("Forced shutdown after timeout."); process.exit(1); }, 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Last-resort safety nets — log, then exit so pm2 restarts a clean process.
  process.on("unhandledRejection", (reason) => console.error("UnhandledRejection:", reason));
  process.on("uncaughtException", (err) => {
    console.error("UncaughtException:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
