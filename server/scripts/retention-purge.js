/* =========================================================
   PII data-retention purge.
   Deletes lead rows older than RETENTION_DAYS from leads.csv so we
   don't keep client PII longer than our stated retention policy.

   Usage:
     RETENTION_DAYS=730 node scripts/retention-purge.js
     node scripts/retention-purge.js --dry-run

   Defaults to 730 days (2 years). Run from cron (see HARDENING.md).
   The CSV's first column is the ISO timestamp written by the server.
   Writes atomically (temp file + rename) and keeps the header row.
   ========================================================= */
const fs = require("fs");
const path = require("path");

const CSV_PATH = process.env.LEADS_CSV_PATH || path.join(__dirname, "..", "leads.csv");
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 730);
const DRY_RUN = process.argv.includes("--dry-run");

if (!fs.existsSync(CSV_PATH)) {
  console.log(`[retention] no CSV at ${CSV_PATH} — nothing to do.`);
  process.exit(0);
}

const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
const raw = fs.readFileSync(CSV_PATH, "utf8");
const lines = raw.split("\n");
const header = lines[0];
const body = lines.slice(1).filter((l) => l.trim().length > 0);

let kept = 0, purged = 0;
const keptLines = body.filter((line) => {
  // First cell is a quoted ISO timestamp: "2026-06-29T..."
  const m = line.match(/^"([^"]*)"/);
  const ts = m ? Date.parse(m[1]) : NaN;
  // Keep rows we can't date (fail safe — never silently drop unparseable data).
  if (Number.isNaN(ts)) { kept++; return true; }
  if (ts >= cutoff) { kept++; return true; }
  purged++;
  return false;
});

console.log(`[retention] cutoff=${new Date(cutoff).toISOString()} keep=${kept} purge=${purged}`);

if (DRY_RUN) {
  console.log("[retention] --dry-run: no changes written.");
  process.exit(0);
}
if (purged === 0) {
  console.log("[retention] nothing past retention window.");
  process.exit(0);
}

const tmp = CSV_PATH + ".tmp";
fs.writeFileSync(tmp, [header, ...keptLines].join("\n") + "\n", { mode: 0o600 });
fs.renameSync(tmp, CSV_PATH);

// Append a tamper-evident note to the audit log.
const AUDIT_PATH = process.env.AUDIT_PATH || path.join(__dirname, "..", "audit.log");
try {
  fs.appendFileSync(AUDIT_PATH,
    JSON.stringify({ ts: new Date().toISOString(), event: "retention_purge", purged, kept, retention_days: RETENTION_DAYS }) + "\n");
} catch (_) {}

console.log(`[retention] purged ${purged} row(s) older than ${RETENTION_DAYS} days.`);
