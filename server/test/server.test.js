/* =========================================================
   Tests for the lead-intake backend.
   Run with:  npm test     (uses Node's built-in test runner)

   Covers:
   - unit:        input sanitization, HTML escaping, CSV formula-injection guard
   - integration: /health, honeypot, validation, happy-path /api/lead, 404
   - regression:  CSV formula-injection (=,+,-,@) is neutralized on disk
   No external test deps — uses node:test + node:assert + global fetch.
   ========================================================= */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate side-effects: point CSV + audit log at temp files, lock down config.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lead-test-"));
process.env.LEADS_CSV_PATH = path.join(TMP, "leads.csv");
process.env.AUDIT_PATH = path.join(TMP, "audit.log");
process.env.ALLOWED_ORIGINS = "https://example.com";
// No SMTP configured on purpose — email must be best-effort, never fatal.

const app = require("../server.js");
const { clean, esc } = app.__test;

let server, base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(() => server && server.close());

/* NOTE: the /api/lead route limiter allows 5 requests per IP per 10 min.
   Exactly 5 tests below send well-formed POSTs that reach the limiter
   (malformed-JSON and oversized bodies fail in the body parser first and
   don't count). If you add another POST test, it will get a 429 — bump
   the pool or restructure. */
function postLead(body) {
  return fetch(`${base}/api/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ---------------- unit ---------------- */

test("clean() strips newlines and trims/truncates", () => {
  assert.strictEqual(clean("  hi\r\nthere  "), "hi there");
  assert.strictEqual(clean("abcdef", 3), "abc");
  assert.strictEqual(clean(null), "");
});

test("esc() neutralizes HTML/script injection", () => {
  assert.strictEqual(
    esc('<script>alert("x")</script>'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
  );
});

/* ------------- integration ------------- */

test("GET /health returns ok", async () => {
  const r = await fetch(`${base}/health`);
  const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(j.ok, true);
});

test("honeypot field silently accepts without saving", async () => {
  const before = readCsv();
  const r = await postLead({ company: "bot inc", name: "Bot", phone: "5551234567" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(readCsv(), before, "honeypot submission must not be written to CSV");
});

test("validation rejects missing name/phone", async () => {
  const r = await postLead({ name: "A", phone: "123" });
  assert.strictEqual(r.status, 400);
});

test("happy-path lead saves to CSV and responds ok (email best-effort)", async () => {
  const r = await postLead({
    name: "Jane Doe",
    phone: "(555) 123-4567",
    email: "jane@example.com",
    consent: true,
    consent_text: "I agree to be contacted",
  });
  const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.emailed, false, "no SMTP configured, so emailed must be false but request still ok");
  // Regression: SMS is best-effort too — with no Twilio config the request
  // must still succeed and report texted:false (never throw, never block).
  assert.strictEqual(j.texted, false, "no Twilio configured, so texted must be false but request still ok");
  assert.match(readCsv(), /Jane Doe/);
});

test("unknown route returns 404 JSON", async () => {
  const r = await fetch(`${base}/nope`);
  assert.strictEqual(r.status, 404);
});

/* ------------- regression ------------- */
// CSV/Excel formula injection: a name like "=cmd()" must be neutralized
// on disk with a leading apostrophe so spreadsheets don't execute it.
test("regression: CSV formula injection is neutralized", async () => {
  await postLead({ name: "=2+5+cmd|' /c calc'!A1", phone: "5559998888", consent: true });
  const csv = readCsv();
  assert.match(csv, /"'=2\+5\+cmd/, "formula cell must be prefixed with an apostrophe");
});

// Malformed JSON must be answered 4xx (client error), never 500.
test("regression: malformed JSON body returns 400, not 500", async () => {
  const r = await fetch(`${base}/api/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.strictEqual(r.status, 400);
  const j = await r.json();
  assert.strictEqual(j.ok, false);
});

// Oversized payloads must be answered 413, never 500.
test("regression: oversized body returns 413", async () => {
  const r = await fetch(`${base}/api/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Big", phone: "5551230000", details: "x".repeat(30000) }),
  });
  assert.strictEqual(r.status, 413);
});

// The consent timestamp is a legal record: a spoofed/garbage client
// timestamp must be replaced with server time.
test("regression: bogus submitted_at is replaced with server time", async () => {
  await postLead({ name: "Time Test", phone: "5551112222", consent: true, submitted_at: "1999-01-01T00:00:00Z" });
  const csv = readCsv();
  const line = csv.split("\n").find((l) => l.includes("Time Test"));
  assert.ok(line, "lead row must exist");
  assert.ok(!line.includes("1999"), "spoofed timestamp must not be stored");
  assert.match(line, /^"\d{4}-\d{2}-\d{2}T/, "row must start with a server ISO timestamp");
});

function readCsv() {
  try { return fs.readFileSync(process.env.LEADS_CSV_PATH, "utf8"); }
  catch { return ""; }
}
