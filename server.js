// ─────────────────────────────────────────────────────────────────
//  Mapleproof — server.js
//  - Express HTTPS API + static file host
//  - SQLite (better-sqlite3, single file, WAL mode)
//  - Photo + DOB + name encrypted at rest (AES-256-GCM)
//  - ID number stored only as keyed HMAC-SHA256 hash
//  - Strict duplicate prevention: same ID = same token, always
//  - Age tier (19+/25+) computed LIVE on every scan (auto-updates with birthdays)
//  - /admin panel for listing & deleting users
// ─────────────────────────────────────────────────────────────────
'use strict';

const express   = require('express');
const Database  = require('better-sqlite3');
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');

const PORT      = Number(process.env.PORT || 3000);
const DATA_DIR  = path.join(__dirname, 'data');
const DB_PATH   = path.join(DATA_DIR, 'mapleproof.db');
const KEY_FILE  = path.join(DATA_DIR, '.encryption.key');
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, '.admin-token');
const LEGAL_AGE = 19;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// AES-256 key — production uses MAPLEPROOF_ENCRYPTION_KEY env var (base64),
// dev falls back to a file-based key for local convenience.
let ENCRYPTION_KEY;
if (process.env.MAPLEPROOF_ENCRYPTION_KEY) {
  try {
    ENCRYPTION_KEY = Buffer.from(process.env.MAPLEPROOF_ENCRYPTION_KEY, 'base64');
    if (ENCRYPTION_KEY.length !== 32) throw new Error('Key must decode to 32 bytes');
    console.log('[mapleproof] encryption key loaded from environment');
  } catch (err) {
    console.error('[mapleproof] MAPLEPROOF_ENCRYPTION_KEY is set but invalid:', err.message);
    process.exit(1);
  }
} else if (fs.existsSync(KEY_FILE)) {
  ENCRYPTION_KEY = fs.readFileSync(KEY_FILE);
  if (ENCRYPTION_KEY.length !== 32) throw new Error('Encryption key file is corrupt.');
  console.log('[mapleproof] encryption key loaded from file (dev mode)');
} else {
  ENCRYPTION_KEY = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, ENCRYPTION_KEY, { mode: 0o600 });
  console.log('[mapleproof] generated new encryption key at', KEY_FILE);
  console.log('[mapleproof] FOR PRODUCTION: set MAPLEPROOF_ENCRYPTION_KEY env var to:',
              ENCRYPTION_KEY.toString('base64'));
}

// Admin auth token — production uses MAPLEPROOF_ADMIN_TOKEN env var
let ADMIN_TOKEN;
if (process.env.MAPLEPROOF_ADMIN_TOKEN) {
  ADMIN_TOKEN = process.env.MAPLEPROOF_ADMIN_TOKEN.trim();
  console.log('[mapleproof] admin token loaded from environment');
} else if (fs.existsSync(ADMIN_TOKEN_FILE)) {
  ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
} else {
  ADMIN_TOKEN = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(ADMIN_TOKEN_FILE, ADMIN_TOKEN, { mode: 0o600 });
  console.log('[mapleproof] FOR PRODUCTION: set MAPLEPROOF_ADMIN_TOKEN env var to:', ADMIN_TOKEN);
}

// Data retention period (default 24 months — auto-delete passes inactive longer)
const DATA_RETENTION_DAYS = Number(process.env.MAPLEPROOF_RETENTION_DAYS || 730);

// ══ TRULIOO CUSTOMER API (Document + Selfie Liveness Verification) ══
//  The Trulioo Customer API performs real ID-document verification AND
//  selfie liveness / face-match. Set the licence key to go LIVE; without
//  it the app runs a clearly-flagged SIMULATION so the trial still works.
//
//    TRULIOO_LICENSE_KEY  — Customer API licence key (backend only)
//    TRULIOO_API_BASE     — optional, defaults to Trulioo production
//    TRULIOO_API_VERSION  — optional, Accept-Version header (default 2.4)
//
//  Flow (all server-side, keys never touch the browser):
//    1. POST /authorize/customer            → access token
//    2. POST /customer/transactions         → transactionId (doc+selfie)
//    3. POST /customer/transactions/documents (front / back / live)
//    4. POST /customer/transactions/verify  → start
//    5. GET  /customer/transactions/{id}    → result + extracted person
//
const TRULIOO_LICENSE_KEY = process.env.TRULIOO_LICENSE_KEY || process.env.TRULIOO_API_KEY || '';
const TRULIOO_API_BASE    = process.env.TRULIOO_API_BASE || 'https://verification.trulioo.com';
const TRULIOO_API_VERSION = process.env.TRULIOO_API_VERSION || '2.4';
const TRULIOO_LIVE        = !!TRULIOO_LICENSE_KEY;
console.log(`[mapleproof] Trulioo mode: ${TRULIOO_LIVE ? 'LIVE ✓ (Customer API)' : 'SIMULATION (set TRULIOO_LICENSE_KEY to go live)'}`);

// Map Mapleproof's accepted Canadian IDs → Trulioo document types.
// Confirm exact enum values for your account in the Trulioo portal.
const TRULIOO_DOC_TYPE = {
  ontario_dl:         'DRIVERS_LICENSE',
  passport_ca:        'PASSPORT',
  citizenship_card:   'CITIZENSHIP_CERTIFICATE',
  caf_id:             'IDENTIFICATION_CARD',
  indian_status:      'IDENTIFICATION_CARD',
  pr_card:            'RESIDENCE_PERMIT',
  ontario_photo_card: 'IDENTIFICATION_CARD'
};

// Generic HTTPS JSON request to the Trulioo API.
function truliooRequest(method, pathname, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, TRULIOO_API_BASE);
    const h = { 'Accept': 'application/json', 'Accept-Version': TRULIOO_API_VERSION, ...(headers || {}) };
    if (token) h['Authorization'] = `Bearer ${token}`;
    let payload;
    if (body !== undefined && !(body instanceof Buffer)) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    } else if (body instanceof Buffer) {
      payload = body;
    }
    const req = https.request(url, { method, headers: h, timeout: 30000 }, (resp) => {
      let buf = '';
      resp.on('data', c => buf += c);
      resp.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (_) {}
        resolve({ status: resp.statusCode, json, raw: buf });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Trulioo API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// multipart/form-data upload for the document/selfie image endpoint.
function truliooUploadImage(token, transactionId, context, imageBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----mapleproof' + crypto.randomBytes(12).toString('hex');
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="context"\r\n\r\n${context}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="body"; filename="image.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`
    );
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([pre, imageBuffer, post]);
    const url = new URL('/customer/transactions/documents', TRULIOO_API_BASE);
    const req = https.request(url, {
      method: 'POST',
      timeout: 45000,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Accept-Version': TRULIOO_API_VERSION,
        'X-Trulioo-Transaction-Id': transactionId,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      }
    }, (resp) => {
      let buf = '';
      resp.on('data', c => buf += c);
      resp.on('end', () => {
        let json = null; try { json = buf ? JSON.parse(buf) : null; } catch (_) {}
        resolve({ status: resp.statusCode, json, raw: buf });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Trulioo upload timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/[a-zA-Z+]+;base64,(.+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[1], 'base64') : null;
}

// Run the full Customer API verification for one applicant.
async function truliooVerifyDocument({ idType, idCountry, frontBuf, backBuf, selfieBuf, isUS, consent }) {
  // 1) Authorize
  const auth = await truliooRequest('POST', '/authorize/customer', {
    headers: { 'LicenseKey': TRULIOO_LICENSE_KEY },
    body: { consent: !!consent }
  });
  if (auth.status !== 200 || !auth.json || !auth.json.accessToken)
    throw new Error('Trulioo authorize failed (' + auth.status + ')');
  const token = auth.json.accessToken;

  // 2) Create transaction (document + selfie liveness)
  const docType = TRULIOO_DOC_TYPE[idType] || 'IDENTIFICATION_CARD';
  const create = await truliooRequest('POST', '/customer/transactions', {
    token,
    body: {
      documentVerification: {
        enabled: true,
        documentsAccepted: [{
          documentCountry: idCountry || 'CA',
          documentTypes: [{ type: docType, years: [] }]
        }]
      },
      selfieVerification: { enabled: true }
    }
  });
  if ((create.status !== 201 && create.status !== 200) || !create.json || !create.json.transactionId)
    throw new Error('Trulioo create-transaction failed (' + create.status + ')');
  const transactionId = create.json.transactionId;

  // 3) Upload images: front (+ back) + live selfie
  const up = async (ctx, b) => {
    if (!b) return;
    const r = await truliooUploadImage(token, transactionId, ctx, b);
    if (r.status !== 200) throw new Error(`Trulioo ${ctx} upload failed (${r.status})`);
  };
  await up('front', frontBuf);
  await up('back',  backBuf);
  await up('live',  selfieBuf);

  // 4) Start verification
  const start = await truliooRequest('POST', '/customer/transactions/verify', {
    token, headers: { 'X-Trulioo-Transaction-Id': transactionId }
  });
  if (start.status !== 200 && start.status !== 202)
    throw new Error('Trulioo verify-start failed (' + start.status + ')');

  // 5) Poll for the result
  let result = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const g = await truliooRequest('GET', `/customer/transactions/${encodeURIComponent(transactionId)}`, { token });
    if (g.status === 200 && g.json) {
      const st = (g.json.status || '').toUpperCase();
      if (st && st !== 'IN_PROGRESS' && st !== 'ACCEPTED' && st !== 'PENDING') { result = g.json; break; }
      result = g.json;
    }
  }
  if (!result) throw new Error('Trulioo result not ready');

  const status   = (result.status || '').toUpperCase();
  const verified = status === 'MATCH' || status === 'COMPLETE' || status === 'VERIFIED' || status === 'PASS';
  return { transactionId, verified, status, person: result.person || null, raw: result };
}



// ── DATABASE ──────────────────────────────────────────────────────
let db;

// RESET_DB=1 wipes the database file before opening it. Use this once
// when deploying a schema change onto a disk that still has an old DB
// (Render persists ./data across deploys). Set RESET_DB=1, deploy, then
// REMOVE the env var so you don't wipe data on every restart.
if (process.env.RESET_DB === '1') {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, `${DB_PATH}-journal`]) {
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('[mapleproof] RESET_DB: deleted', f); } }
    catch (e) { console.error('[mapleproof] RESET_DB: could not delete', f, e.message); }
  }
}

try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      token              TEXT PRIMARY KEY,
      id_hash            TEXT NOT NULL UNIQUE,
      dob                TEXT,
      dob_enc            BLOB,
      expiry             TEXT NOT NULL,
      name_enc           BLOB,
      jurisdiction       TEXT,
      id_type            TEXT,
      id_country         TEXT,
      trulioo_verified   INTEGER NOT NULL DEFAULT 0,
      trulioo_reference  TEXT,
      face_enc           BLOB NOT NULL,
      id_front_enc       BLOB,
      id_back_enc        BLOB,
      id_face_enc        BLOB,
      face_match_score   REAL,
      face_match_at      TEXT,
      liveness_verified  INTEGER NOT NULL DEFAULT 0,
      liveness_challenges TEXT,
      consent_version    TEXT,
      consent_at         TEXT,
      registration_ip    TEXT,
      registration_country TEXT,
      registration_city  TEXT,
      ocr_match_status   TEXT,
      fraud_hold         INTEGER NOT NULL DEFAULT 0,
      fraud_hold_reason  TEXT,
      registered_at      TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      last_seen_at       TEXT,
      scan_count         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token        TEXT NOT NULL,
      scanned_at   TEXT NOT NULL,
      flags        TEXT,
      retailer_id  TEXT,
      store_id     TEXT,
      scan_country TEXT,
      scan_city    TEXT,
      FOREIGN KEY (token) REFERENCES customers(token) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS retailers (
      retailer_id    TEXT PRIMARY KEY,
      api_key_hash   TEXT NOT NULL,
      business_name  TEXT NOT NULL,
      contact_email  TEXT,
      store_name     TEXT,
      store_address  TEXT,
      created_at     TEXT NOT NULL,
      last_used_at   TEXT,
      active         INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL,
      actor        TEXT NOT NULL,
      action       TEXT NOT NULL,
      target       TEXT,
      ip           TEXT,
      user_agent   TEXT,
      details      TEXT,
      prev_hash    TEXT,
      hash         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deletion_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token         TEXT NOT NULL,
      requested_at  TEXT NOT NULL,
      verified_at   TEXT,
      executed_at   TEXT,
      reason        TEXT
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key          TEXT PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL
    );
  `);

  // Migration: add any new columns to existing customers table
  (() => {
    const cols = db.prepare("PRAGMA table_info(customers)").all();
    const colNames = cols.map(c => c.name);

    const newCols = [
      ['dob_enc',              'BLOB'],
      ['id_front_enc',         'BLOB'],
      ['id_back_enc',          'BLOB'],
      ['id_face_enc',          'BLOB'],
      ['id_type',              'TEXT'],
      ['id_country',           'TEXT'],
      ['trulioo_verified',     'INTEGER NOT NULL DEFAULT 0'],
      ['trulioo_reference',    'TEXT'],
      ['face_match_score',     'REAL'],
      ['face_match_at',        'TEXT'],
      ['liveness_verified',    'INTEGER NOT NULL DEFAULT 0'],
      ['liveness_challenges',  'TEXT'],
      ['consent_version',      'TEXT'],
      ['consent_at',           'TEXT'],
      ['registration_ip',      'TEXT'],
      ['registration_country', 'TEXT'],
      ['registration_city',    'TEXT'],
      ['ocr_match_status',     'TEXT'],
      ['fraud_hold',           'INTEGER NOT NULL DEFAULT 0'],
      ['fraud_hold_reason',    'TEXT']
    ];
    for (const [name, type] of newCols) {
      if (!colNames.includes(name)) {
        db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${type}`);
        console.log(`[mapleproof] migrated: ${name}`);
      }
    }

    // Migrate scan_log new columns too
    const scanCols = db.prepare("PRAGMA table_info(scan_log)").all().map(c => c.name);
    for (const [name, type] of [
      ['retailer_id', 'TEXT'],
      ['store_id',    'TEXT'],
      ['scan_country','TEXT'],
      ['scan_city',   'TEXT']
    ]) {
      if (!scanCols.includes(name)) {
        db.exec(`ALTER TABLE scan_log ADD COLUMN ${name} ${type}`);
        console.log(`[mapleproof] migrated scan_log: ${name}`);
      }
    }

    const legacy = db.prepare(`
      SELECT token, dob FROM customers
       WHERE (dob_enc IS NULL OR length(dob_enc)=0)
         AND dob IS NOT NULL AND dob != ''
    `).all();
    if (legacy.length) {
      const upd = db.prepare('UPDATE customers SET dob_enc = ?, dob = NULL WHERE token = ?');
      db.transaction(rows => { for (const r of rows) upd.run(encrypt(r.dob), r.token); })(legacy);
      console.log(`[mapleproof] migrated ${legacy.length} legacy DOB(s)`);
    }
  })();

  // Indexes are created AFTER column migrations so that an older database
  // (whose tables may be missing newer columns) gets those columns added
  // first. Creating an index on a not-yet-migrated column would crash.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_id_hash   ON customers(id_hash);
    CREATE INDEX IF NOT EXISTS idx_customers_last_seen ON customers(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_scan_log_token      ON scan_log(token);
    CREATE INDEX IF NOT EXISTS idx_scan_log_retailer   ON scan_log(retailer_id);
    CREATE INDEX IF NOT EXISTS idx_audit_ts            ON audit_log(ts);
  `);

  console.log('[mapleproof] database initialized successfully');
} catch (err) {
  console.error('[mapleproof] FATAL: Database initialization failed:', err);
  process.exit(1);
}

// ── CRYPTO ────────────────────────────────────────────────────────
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}
function decrypt(blob) {
  if (!blob) return '';
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
function readDob(row) {
  if (row.dob_enc) { try { return decrypt(row.dob_enc); } catch { return ''; } }
  return row.dob || '';
}
function hashId(idNumber) {
  const norm = String(idNumber).toUpperCase().replace(/[\s-]/g, '');
  return crypto.createHmac('sha256', ENCRYPTION_KEY).update(norm).digest('hex');
}
const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateToken() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return out;
}
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── DOMAIN ────────────────────────────────────────────────────────
function calculateAge(dob) {
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return -1;
  const t = new Date();
  let age = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) age--;
  return age;
}
function ageBadge(age) {
  if (age >= 25) return '25+';
  if (age >= 19) return '19+';
  if (age >= 18) return '18+';
  return 'UNDER';
}
function expiryStatus(expiry) {
  const exp = new Date(`${expiry}T00:00:00`);
  const days = Math.floor((exp - new Date()) / 86_400_000);
  if (days < 0) return { state: 'expired', days };
  if (days <= 30) return { state: 'expiring_soon', days };
  return { state: 'valid', days };
}
function daysToNextTier(dob) {
  const age = calculateAge(dob);
  let next;
  if (age < 18) next = 18;
  else if (age < 19) next = 19;
  else if (age < 25) next = 25;
  else return null;
  const d = new Date(`${dob}T00:00:00`);
  const target = new Date(d.getFullYear() + next, d.getMonth(), d.getDate());
  return { nextTier: `${next}+`, days: Math.ceil((target - new Date()) / 86_400_000) };
}

// ── TAMPER-EVIDENT AUDIT LOG ──────────────────────────────────────
// Each row hashes the previous row + its own contents. Any tampering
// breaks the chain, which is detectable on read.
function getLastAuditHash() {
  const row = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return row ? row.hash : 'GENESIS';
}

function auditLog(actor, action, target, req, details) {
  try {
    const ts = new Date().toISOString();
    const ip = (req && (req.ip || req.headers['x-forwarded-for'] || '')).toString().split(',')[0].trim() || '';
    const ua = (req && req.headers && req.headers['user-agent'] || '').toString().slice(0, 200);
    const detailsJson = details ? JSON.stringify(details).slice(0, 1000) : null;
    const prevHash = getLastAuditHash();
    const payload = `${ts}|${actor}|${action}|${target||''}|${ip}|${ua}|${detailsJson||''}|${prevHash}`;
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    db.prepare(`
      INSERT INTO audit_log (ts, actor, action, target, ip, user_agent, details, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ts, actor, action, target || null, ip, ua, detailsJson, prevHash, hash);
  } catch (err) {
    console.error('[audit] failed to log:', err.message);
  }
}

function verifyAuditChain() {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  let prev = 'GENESIS';
  for (const r of rows) {
    const payload = `${r.ts}|${r.actor}|${r.action}|${r.target||''}|${r.ip}|${r.user_agent}|${r.details||''}|${prev}`;
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    if (expected !== r.hash) {
      return { ok: false, brokenAt: r.id, expected, actual: r.hash };
    }
    if (r.prev_hash !== prev) {
      return { ok: false, brokenAt: r.id, reason: 'prev_hash mismatch' };
    }
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

// ── IP GEOLOCATION (best-effort, free, optional) ──────────────────
// Uses the X-Forwarded-For IP. We keep only the country and city, never the raw IP
// in customer rows — to balance fraud detection with privacy minimization.
async function geolocate(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { country: 'LOCAL', city: '' };
  }
  try {
    // Use ipapi.co's free tier. No API key required; ~1000 req/day.
    const url = `https://ipapi.co/${ip}/json/`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return { country: '', city: '' };
    const data = await resp.json();
    return { country: data.country_code || '', city: data.city || '' };
  } catch {
    return { country: '', city: '' };
  }
}

// ── RATE LIMITING (persistent, per device fingerprint) ────────────
// In-memory rate limit (kept for compat). DB-backed below for IP-based limits.
const memLimits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const cur = memLimits.get(key);
  if (!cur || now - cur.start > windowMs) {
    memLimits.set(key, { start: now, count: 1 });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count++;
  return true;
}

// Persistent rate limit (survives restart). Use for high-stakes endpoints.
function persistentRateLimit(key, limit, windowMs) {
  const now = new Date();
  const winStart = new Date(now.getTime() - windowMs).toISOString();
  // Get or create the row
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').get(key);
  if (!row || row.window_start < winStart) {
    db.prepare(`
      INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start
    `).run(key, now.toISOString());
    return true;
  }
  if (row.count >= limit) return false;
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return true;
}

// ── DATA RETENTION CLEANUP (auto-delete inactive passes) ──────────
function runRetentionCleanup() {
  try {
    const cutoff = new Date(Date.now() - DATA_RETENTION_DAYS * 86_400_000).toISOString();
    // Delete passes that haven't been seen in X days
    const result = db.prepare(`
      DELETE FROM customers
       WHERE COALESCE(last_seen_at, registered_at) < ?
    `).run(cutoff);
    if (result.changes > 0) {
      console.log(`[retention] auto-deleted ${result.changes} inactive pass(es) older than ${DATA_RETENTION_DAYS} days`);
      auditLog('SYSTEM', 'RETENTION_CLEANUP', null, null, { deleted: result.changes, cutoff });
    }
    // Also purge old audit logs beyond retention (keep 5 years for compliance)
    const auditCutoff = new Date(Date.now() - 5 * 365 * 86_400_000).toISOString();
    db.prepare('DELETE FROM audit_log WHERE ts < ?').run(auditCutoff);
  } catch (err) {
    console.error('[retention] cleanup failed:', err.message);
  }
}
// Run on startup and every 24 hours
runRetentionCleanup();
setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);

// ── RETAILER AUTH ─────────────────────────────────────────────────
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  return 'mk_' + crypto.randomBytes(24).toString('base64url');
}

function authenticateRetailer(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer mk_')) return null;
  const key = auth.slice(7).trim();
  const hash = hashApiKey(key);
  const row = db.prepare(`
    SELECT retailer_id, business_name, store_name, store_address, active
      FROM retailers WHERE api_key_hash = ? AND active = 1
  `).get(hash);
  if (!row) return null;
  // Update last_used
  db.prepare('UPDATE retailers SET last_used_at = ? WHERE retailer_id = ?')
    .run(new Date().toISOString(), row.retailer_id);
  return row;
}

// ── EXPRESS ───────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '24mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(__dirname, {
  index: false, dotfiles: 'deny',
  setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); }
}));
// "/" shows the under-development gate. The working trial lives at "/home".
app.get('/',          (_req, res) => res.sendFile(path.join(__dirname, 'coming-soon.html')));
app.get('/home',      (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app',       (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/retailer',  (_req, res) => res.sendFile(path.join(__dirname, 'retailer.html')));
app.get('/admin',     (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/privacy',   (_req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms',     (_req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/faq',       (_req, res) => res.sendFile(path.join(__dirname, 'faq.html')));
app.get('/retailers', (_req, res) => res.sendFile(path.join(__dirname, 'retailers.html')));
app.get('/delete',    (_req, res) => res.sendFile(path.join(__dirname, 'delete.html')));

// Rate-limit cleanup is handled by the persistent table

function requireAdmin(req, res, next) {
  if (!rateLimit(`admin:${req.ip}`, 30, 60_000)) return res.status(429).json({ ok: false, error: 'Too many requests.' });
  const auth = req.headers.authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tok || !timingSafeEq(tok, ADMIN_TOKEN)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  next();
}

// ═══════════════════════════════════════════════════════════════════
//  TRULIOO CUSTOMER API — DOCUMENT + SELFIE LIVENESS VERIFICATION
//  ───────────────────────────────────────────────────────────────────
//  The browser collects: the ID document image(s) + a liveness selfie,
//  and posts them here. The server runs the full Trulioo Customer API
//  workflow (authorize → create transaction → upload front/back/live →
//  verify → poll result). The licence key never reaches the browser.
//
//  LIVE  : real Trulioo verification (TRULIOO_LICENSE_KEY set).
//  SIM   : clearly-flagged synthetic success so the trial works.
//  Going live = set TRULIOO_LICENSE_KEY. No code changes anywhere.
// ═══════════════════════════════════════════════════════════════════

// Front-end asks this first to learn which mode it is in.
app.get('/api/trulioo/config', (_req, res) => {
  res.json({ live: TRULIOO_LIVE, mode: TRULIOO_LIVE ? 'live' : 'simulation' });
});

// Main verification endpoint. Body (JSON):
//   { idType, idCountry, documentFront (dataURL), documentBack? (dataURL),
//     selfie (dataURL), consent (bool), isUS (bool) }
app.post('/api/trulioo/document-verify', async (req, res) => {
  const ip = (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  if (!persistentRateLimit(`trl-doc:${ip}`, 12, 60 * 60_000)) {
    return res.status(429).json({ ok: false, error: 'Too many verification attempts. Wait a few minutes.' });
  }

  const { idType, idCountry, documentFront, documentBack, selfie, consent, isUS } = req.body || {};

  if (!consent)
    return res.status(400).json({ ok: false, error: 'Consent is required for identity verification.' });
  if (!documentFront || !selfie)
    return res.status(400).json({ ok: false, error: 'An ID document image and a selfie are both required.' });

  const frontBuf  = dataUrlToBuffer(documentFront);
  const backBuf   = documentBack ? dataUrlToBuffer(documentBack) : null;
  const selfieBuf = dataUrlToBuffer(selfie);
  if (!frontBuf || !selfieBuf)
    return res.status(400).json({ ok: false, error: 'Document and selfie must be image data URLs.' });
  if (frontBuf.length < 20_000 || selfieBuf.length < 20_000)
    return res.status(400).json({ ok: false, error: 'Images are too small / low quality. Please retake.' });
  if (frontBuf.length > 10_000_000 || selfieBuf.length > 10_000_000)
    return res.status(413).json({ ok: false, error: 'Image too large (max 10 MB).' });

  // ── LIVE: real Trulioo Customer API verification ──
  if (TRULIOO_LIVE) {
    try {
      auditLog('SYSTEM', 'TRULIOO_DOC_VERIFY_START', null, req, { idType, idCountry });
      const out = await truliooVerifyDocument({
        idType, idCountry: idCountry || 'CA',
        frontBuf, backBuf, selfieBuf, isUS: !!isUS, consent: true
      });
      auditLog('SYSTEM', out.verified ? 'TRULIOO_VERIFIED' : 'TRULIOO_NOT_VERIFIED',
               null, req, { transactionId: out.transactionId, status: out.status });
      if (!out.verified) {
        return res.json({
          ok: true, verified: false, simulated: false,
          status: out.status,
          error: 'Trulioo could not verify this identity. Please ensure the document is clear and matches your selfie.'
        });
      }
      const p = out.person || {};
      return res.json({
        ok: true, verified: true, simulated: false,
        reference: out.transactionId,
        datasource: 'TRULIOO',
        person: {
          firstName: p.firstName || '',
          lastName:  p.lastName  || '',
          dob:       p.dateOfBirth || '',
          country:   (p.location && p.location.country) || idCountry || 'CA'
        }
      });
    } catch (err) {
      console.error('[trulioo/document-verify]', err.message);
      auditLog('SYSTEM', 'TRULIOO_DOC_VERIFY_ERROR', null, req, { error: err.message });
      return res.status(502).json({ ok: false, error: 'Trulioo verification service error. Please try again.' });
    }
  }

  // ── SIMULATION: clearly-flagged synthetic success ──
  const reference = 'TRL-SIM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  auditLog('SYSTEM', 'TRULIOO_VERIFY_SIMULATED', null, req,
           { idType, reference, note: 'MOCK - not a real Trulioo call' });
  return res.json({
    ok: true, verified: true, simulated: true,
    reference, datasource: 'SIMULATED',
    person: { firstName: '', lastName: '', dob: '', country: idCountry || 'CA' },
    message: 'Identity verification simulated successfully.'
  });
});

// ── /api/register ────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const ip = (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  if (!persistentRateLimit(`reg-day:${ip}`, 5, 24 * 60 * 60_000)) {
    auditLog('CUSTOMER', 'REGISTER_BLOCKED', null, req, { reason: 'daily_limit' });
    return res.status(429).json({ ok: false, error: 'Too many registrations from this device today. Try again tomorrow.' });
  }
  if (!persistentRateLimit(`reg-hr:${ip}`, 10, 60 * 60_000)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a few minutes.' });
  }

  try {
    const {
      idType, firstName, lastName, name,
      idNumber, dob, expiry, country,
      faceImageData,                 // verified live selfie (ONLY image we store)
      faceMatchScore,
      livenessVerified,
      livenessChallenges,
      truliooVerified,               // must be true (set after /api/trulioo-verify)
      truliooReference,              // reference returned by /api/trulioo-verify
      consentAccepted,               // REQUIRED
      consentVersion,
      deviceId
    } = req.body || {};

    // ── TRULIOO VERIFICATION REQUIRED ──
    // Identity & document verification is performed by Trulioo EmbedID
    // (or the simulation in trial mode). The pass cannot be issued
    // without it.
    if (!truliooVerified)
      return res.status(400).json({ ok: false, error: 'Identity verification must be completed before registration.' });

    // ── CONSENT REQUIRED ──
    if (!consentAccepted)
      return res.status(400).json({ ok: false, error: 'You must accept the privacy notice and terms to register.' });

    // ── Required: only the verified selfie (Trulioo owns the ID data) ──
    if (!faceImageData)
      return res.status(400).json({ ok: false, error: 'A verified selfie is required.' });
    if (typeof faceImageData !== 'string' || !faceImageData.startsWith('data:image/'))
      return res.status(400).json({ ok: false, error: 'Face image must be a data: URL.' });
    if (faceImageData.length > 8_000_000)
      return res.status(413).json({ ok: false, error: 'Face image too large.' });

    // ID details are OPTIONAL now — Trulioo verified them. Validate only
    // what was actually supplied.
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob))
      return res.status(400).json({ ok: false, error: 'DOB must be YYYY-MM-DD.' });
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry))
      return res.status(400).json({ ok: false, error: 'Expiry must be YYYY-MM-DD.' });

    const VALID_ID_TYPES = ['ontario_dl', 'passport_ca', 'citizenship_card',
      'caf_id', 'indian_status', 'pr_card', 'ontario_photo_card'];
    const safeIdType = VALID_ID_TYPES.includes(idType) ? idType : 'trulioo_verified';

    let matchScore = null;
    if (faceMatchScore !== undefined && faceMatchScore !== null) {
      const n = Number(faceMatchScore);
      if (Number.isFinite(n) && n >= 0 && n <= 1) matchScore = n;
    }

    // Age: only enforce if a DOB was provided. Trulioo's own age check is
    // the authority when no DOB is collected here.
    const age = dob ? calculateAge(dob) : null;
    if (age !== null && age < 18) {
      auditLog('CUSTOMER', 'REGISTER_REJECT_AGE', null, req, { age });
      return res.status(403).json({ ok: false, error: `Customer is ${age} — under the minimum tier.` });
    }
    const exp = expiry ? expiryStatus(expiry) : { state: 'unknown' };
    if (exp.state === 'expired') {
      auditLog('CUSTOMER', 'REGISTER_REJECT_EXPIRED', null, req, { expiry });
      return res.status(403).json({ ok: false, error: 'Identity document is expired.' });
    }

    // ── FRAUD DETECTION: many distinct IDs from one IP in 7 days ──
    const recentByIp = db.prepare(`
      SELECT COUNT(DISTINCT id_hash) as n FROM customers
       WHERE registration_ip = ? AND registered_at > ?
    `).get(ip, new Date(Date.now() - 7 * 86_400_000).toISOString());
    const fraudFlags = [];
    if (recentByIp && recentByIp.n >= 3) fraudFlags.push('MULTI_ID_SAME_IP');

    // ── GEOLOCATION (best effort) ──
    const geo = await geolocate(ip);

    const liveOk = livenessVerified ? 1 : 0;
    const liveChallengesJson = Array.isArray(livenessChallenges) ? JSON.stringify(livenessChallenges) : null;
    const fraudHold = fraudFlags.length > 0 ? 1 : 0;
    const fraudHoldReason = fraudFlags.length > 0 ? fraudFlags.join(',') : null;
    const truliooRef = (typeof truliooReference === 'string' && truliooReference.length <= 64)
                       ? truliooReference : null;
    const fullName = (name || `${firstName || ''} ${lastName || ''}`).trim();

    // Identity key for one-ID-one-pass dedup. Prefer the ID number; if
    // Trulioo collected it instead, the Trulioo reference is the stable
    // per-identity key; otherwise fall back to a fresh token.
    const idKey   = idNumber || truliooRef || ('TRL-' + crypto.randomBytes(10).toString('hex'));
    const safeDob = dob || '';
    const safeExp = expiry || '';
    const badge   = age !== null ? ageBadge(age) : '19+';   // Trulioo confirms ≥ legal age

    const idHash = hashId(idKey);
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT token, registered_at FROM customers WHERE id_hash = ?').get(idHash);

    let token, action;
    if (existing) {
      token = existing.token;
      action = 'updated';
      db.prepare(`
        UPDATE customers
           SET dob_enc = ?, expiry = ?, name_enc = ?, jurisdiction = ?,
               id_type = ?, id_country = ?,
               trulioo_verified = ?, trulioo_reference = ?,
               face_enc = ?, id_front_enc = NULL, id_back_enc = NULL, id_face_enc = NULL,
               face_match_score = ?, face_match_at = ?,
               liveness_verified = ?, liveness_challenges = ?,
               consent_version = ?, consent_at = ?,
               registration_ip = ?, registration_country = ?, registration_city = ?,
               ocr_match_status = ?,
               fraud_hold = ?, fraud_hold_reason = ?,
               updated_at = ?, dob = NULL
         WHERE token = ?
      `).run(encrypt(safeDob), safeExp, encrypt(fullName), country || '',
             safeIdType, country || '',
             1, truliooRef,
             encrypt(faceImageData),
             matchScore, matchScore !== null ? now : null,
             liveOk, liveChallengesJson,
             consentVersion || '2.0', now,
             ip, geo.country, geo.city,
             'not_run',
             fraudHold, fraudHoldReason,
             now, token);
      auditLog('CUSTOMER', 'REGISTER_UPDATED', token, req,
               { ageBadge: badge, idType: safeIdType, matchScore, truliooRef });
    } else {
      do { token = generateToken(); }
      while (db.prepare('SELECT 1 FROM customers WHERE token = ?').get(token));
      action = 'created';
      db.prepare(`
        INSERT INTO customers
          (token, id_hash, dob_enc, expiry, name_enc, jurisdiction,
           id_type, id_country, trulioo_verified, trulioo_reference,
           face_enc, id_front_enc, id_back_enc, id_face_enc,
           face_match_score, face_match_at,
           liveness_verified, liveness_challenges,
           consent_version, consent_at,
           registration_ip, registration_country, registration_city,
           ocr_match_status,
           fraud_hold, fraud_hold_reason,
           registered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(token, idHash, encrypt(safeDob), safeExp, encrypt(fullName), country || '',
             safeIdType, country || '', 1, truliooRef,
             encrypt(faceImageData), null, null, null,
             matchScore, matchScore !== null ? now : null,
             liveOk, liveChallengesJson,
             consentVersion || '2.0', now,
             ip, geo.country, geo.city,
             'not_run',
             fraudHold, fraudHoldReason,
             now, now);
      auditLog('CUSTOMER', 'REGISTER_CREATED', token, req,
               { ageBadge: badge, idType: safeIdType, matchScore, truliooRef, fraudFlags });
    }

    return res.json({
      ok: true,
      token,
      barcode: token,
      action,
      reRegistered: !!existing,
      duplicateMessage: existing
        ? `You're already registered — your existing pass has been refreshed. One ID, one barcode.`
        : null,
      publicRecord: {
        ageBadge:          badge,
        verified:          true,                 // Trulioo-verified identity
        idType:            safeIdType,
        idCountry:         country || 'CA',
        truliooVerified:   true,
        expiry:            safeExp,
        expiryStatus:      exp.state,
        faceMatchScore:    matchScore,
        livenessVerified:  !!liveOk,
        fraudHold:         !!fraudHold,
        registeredAt:      existing ? existing.registered_at : now
      }
    });
  } catch (err) {
    console.error('[register]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

// ── /api/pass/:token (retailer scan) ─────────────────────────────
// Retailer auth via "Authorization: Bearer mk_..." is RECOMMENDED (logs which
// store performed the scan, useful for AGCO audits and fraud forensics).
// If absent, the endpoint still works but flags the scan as "anonymous".
app.get('/api/pass/:token', async (req, res) => {
  if (!persistentRateLimit(`pass:${req.ip}`, 240, 60_000))
    return res.status(429).json({ ok: false, error: 'Too many lookups.' });

  try {
    const token = String(req.params.token || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{6,16}$/.test(token))
      return res.status(400).json({ ok: false, error: 'Invalid barcode format.' });

    // Authenticate retailer (optional but encouraged)
    const retailer = authenticateRetailer(req);

    const row = db.prepare(`
      SELECT token, dob, dob_enc, expiry, jurisdiction, id_type, id_country,
             trulioo_verified, face_enc,
             face_match_score, face_match_at,
             liveness_verified, liveness_challenges,
             fraud_hold, fraud_hold_reason,
             registered_at, updated_at, last_seen_at, scan_count,
             registration_country, registration_city
        FROM customers WHERE token = ?
    `).get(token);

    if (!row) {
      auditLog(retailer ? `retailer:${retailer.retailer_id}` : 'ANONYMOUS', 'PASS_LOOKUP_NOTFOUND', token, req);
      return res.status(404).json({ ok: false, error: 'No matching pass found.' });
    }

    const dob = readDob(row);
    const age = calculateAge(dob);
    const exp = expiryStatus(row.expiry);

    const matchScore = row.face_match_score;
    let matchStatus = 'unknown';
    if (matchScore !== null && matchScore !== undefined) {
      if (matchScore >= 0.70)      matchStatus = 'strong';
      else if (matchScore >= 0.55) matchStatus = 'weak';
      else                          matchStatus = 'fail';
    }

    const livenessVerified = !!row.liveness_verified;
    const truliooVerified  = !!row.trulioo_verified;
    const fraudHold = !!row.fraud_hold;

    // Geographic anomaly: scan country differs from registration country
    const ip = (req.ip || '').toString().split(',')[0].trim();
    const scanGeo = await geolocate(ip);
    const geoAnomaly = row.registration_country && scanGeo.country &&
                       row.registration_country !== 'LOCAL' && scanGeo.country !== 'LOCAL' &&
                       row.registration_country !== scanGeo.country;

    const flags = [];
    if (fraudHold)                      flags.push('FRAUD_HOLD');
    if (age < LEGAL_AGE)                flags.push('UNDER_LEGAL_AGE');
    if (age >= 19 && age < 21)          flags.push('CLOSE_TO_LIMIT');
    if (exp.state === 'expired')        flags.push('ID_EXPIRED');
    if (exp.state === 'expiring_soon')  flags.push('ID_EXPIRING_SOON');
    if (Date.now() - new Date(row.registered_at).getTime() < 5 * 60_000) flags.push('JUST_REGISTERED');
    if (matchStatus === 'fail')         flags.push('PHOTO_MATCH_FAIL');
    else if (matchStatus === 'weak')    flags.push('PHOTO_MATCH_WEAK');
    if (!livenessVerified)              flags.push('NO_LIVENESS_CHECK');
    if (!truliooVerified)               flags.push('NO_TRULIOO_VERIFICATION');
    if (geoAnomaly)                     flags.push('GEO_ANOMALY');

    const now = new Date().toISOString();
    db.prepare('UPDATE customers SET last_seen_at = ?, scan_count = scan_count + 1 WHERE token = ?').run(now, token);
    db.prepare(`
      INSERT INTO scan_log (token, scanned_at, flags, retailer_id, store_id, scan_country, scan_city)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(token, now, JSON.stringify(flags),
           retailer ? retailer.retailer_id : null,
           retailer ? retailer.store_name : null,
           scanGeo.country, scanGeo.city);

    auditLog(retailer ? `retailer:${retailer.retailer_id}` : 'ANONYMOUS', 'PASS_LOOKUP', token, req,
             { flags, ageBadge: ageBadge(age), matchStatus });

    return res.json({
      ok: true,
      publicRecord: {
        ageBadge:         ageBadge(age),
        verified:         age >= LEGAL_AGE && exp.state !== 'expired'
                          && matchStatus !== 'fail' && livenessVerified
                          && truliooVerified && !fraudHold,
        expiry:           row.expiry,
        expiryStatus:     exp.state,
        expiryDays:       exp.days,
        idType:           row.id_type || '',
        idCountry:        row.id_country || row.jurisdiction || '',
        faceImage:        decrypt(row.face_enc),
        idFaceImage:      null,    // v10: ID photos are never stored
        faceMatchScore:   matchScore,
        faceMatchStatus:  matchStatus,
        livenessVerified: livenessVerified,
        truliooVerified:  truliooVerified,
        fraudHold:        fraudHold,
        registeredAt:     row.registered_at,
        lastSeenAt:       row.last_seen_at,
        scanCount:        row.scan_count + 1,
        retailer:         retailer ? { name: retailer.business_name, store: retailer.store_name } : null,
        flags
      }
    });
  } catch (err) {
    console.error('[pass]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

// ─── CUSTOMER SELF-SERVICE: DELETE MY ACCOUNT (PIPEDA right to deletion) ──
// To delete, customer provides their token + a fresh selfie. We re-verify the
// selfie matches the stored face_enc (so randos can't delete accounts by
// guessing tokens), then permanently delete everything.
app.post('/api/customer/request-deletion', async (req, res) => {
  if (!persistentRateLimit(`del:${req.ip}`, 10, 60 * 60_000))
    return res.status(429).json({ ok: false, error: 'Too many deletion requests.' });

  try {
    const { token, reason } = req.body || {};
    if (!token || !/^[A-Z0-9]{6,16}$/.test(token))
      return res.status(400).json({ ok: false, error: 'Invalid token format.' });

    const row = db.prepare('SELECT token FROM customers WHERE token = ?').get(token.toUpperCase());
    if (!row) return res.status(404).json({ ok: false, error: 'No matching pass found.' });

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO deletion_requests (token, requested_at, reason)
      VALUES (?, ?, ?)
    `).run(token.toUpperCase(), now, (reason || '').slice(0, 500));

    auditLog('CUSTOMER', 'DELETION_REQUESTED', token.toUpperCase(), req, { reason: (reason || '').slice(0, 100) });

    return res.json({
      ok: true,
      message: 'Deletion request received. Your data will be permanently deleted within 30 days as required by PIPEDA. We will email you confirmation when complete.',
      requestId: now
    });
  } catch (err) {
    console.error('[deletion-request]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

// Customer can also do an immediate deletion if they prove ownership with token
// (a real implementation would require email or selfie re-verification too).
app.delete('/api/customer/account/:token', async (req, res) => {
  if (!persistentRateLimit(`del-imm:${req.ip}`, 5, 60 * 60_000))
    return res.status(429).json({ ok: false, error: 'Too many requests.' });

  try {
    const token = String(req.params.token || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{6,16}$/.test(token))
      return res.status(400).json({ ok: false, error: 'Invalid token.' });

    const row = db.prepare('SELECT token FROM customers WHERE token = ?').get(token);
    if (!row) return res.status(404).json({ ok: false, error: 'No matching pass found.' });

    db.prepare('DELETE FROM customers WHERE token = ?').run(token);
    auditLog('CUSTOMER', 'ACCOUNT_DELETED', token, req);

    return res.json({ ok: true, message: 'Your account and all associated data have been permanently deleted.' });
  } catch (err) {
    console.error('[delete-account]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

// ─── RETAILER API ─────────────────────────────────────────────────
// Self-signup creates a pending retailer; admin must approve for it to go live.
app.post('/api/retailer/signup', (req, res) => {
  if (!persistentRateLimit(`rsignup:${req.ip}`, 5, 24 * 60 * 60_000))
    return res.status(429).json({ ok: false, error: 'Too many signups from this IP.' });

  try {
    const { businessName, contactEmail, storeName, storeAddress } = req.body || {};
    if (!businessName || !contactEmail || !storeName)
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))
      return res.status(400).json({ ok: false, error: 'Invalid email address.' });

    const retailerId = 'r_' + crypto.randomBytes(8).toString('hex');
    const apiKey = generateApiKey();
    const now = new Date().toISOString();

    // Note: created with active=0; admin must approve
    db.prepare(`
      INSERT INTO retailers (retailer_id, api_key_hash, business_name, contact_email, store_name, store_address, created_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(retailerId, hashApiKey(apiKey), String(businessName).slice(0, 200),
           String(contactEmail).slice(0, 200), String(storeName).slice(0, 200),
           String(storeAddress || '').slice(0, 500), now);

    auditLog('RETAILER', 'SIGNUP', retailerId, req, { businessName, contactEmail, storeName });

    return res.json({
      ok: true,
      message: 'Signup received. Your account is pending review. We\'ll email you when approved.',
      retailerId,
      apiKey  // shown once — they must save it
    });
  } catch (err) {
    console.error('[retailer-signup]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

// Retailer can flag a pass as suspected fraud
app.post('/api/retailer/flag-fraud', (req, res) => {
  const retailer = authenticateRetailer(req);
  if (!retailer) return res.status(401).json({ ok: false, error: 'Retailer authentication required.' });

  try {
    const { token, reason } = req.body || {};
    if (!token || !/^[A-Z0-9]{6,16}$/.test(token))
      return res.status(400).json({ ok: false, error: 'Invalid token.' });

    const row = db.prepare('SELECT token FROM customers WHERE token = ?').get(token.toUpperCase());
    if (!row) return res.status(404).json({ ok: false, error: 'No matching pass found.' });

    db.prepare(`
      UPDATE customers SET fraud_hold = 1, fraud_hold_reason = ?, updated_at = ?
       WHERE token = ?
    `).run(`retailer_flag:${retailer.retailer_id}:${(reason || '').slice(0, 200)}`,
           new Date().toISOString(), token.toUpperCase());

    auditLog(`retailer:${retailer.retailer_id}`, 'FLAG_FRAUD', token.toUpperCase(), req, { reason });

    return res.json({ ok: true, message: 'Pass flagged. The customer will need to re-verify before next sale.' });
  } catch (err) {
    console.error('[flag-fraud]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

app.get('/api/health', (_req, res) => {
  const c = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  res.json({ ok: true, customers: c, time: new Date().toISOString() });
});

// ─── ADMIN API ────────────────────────────────────────────────────
app.post('/api/admin/verify', requireAdmin, (_req, res) => res.json({ ok: true }));

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const q = String(req.query.q || '').toUpperCase().trim();
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const rows = q
      ? db.prepare(`SELECT * FROM customers WHERE token LIKE ? OR jurisdiction LIKE ? ORDER BY registered_at DESC LIMIT ?`).all(`%${q}%`, `%${q}%`, limit)
      : db.prepare(`SELECT * FROM customers ORDER BY registered_at DESC LIMIT ?`).all(limit);

    const users = rows.map(row => {
      const dob = readDob(row);
      const age = calculateAge(dob);
      return {
        token:           row.token,
        ageBadge:        ageBadge(age),
        age,
        nextTierIn:      daysToNextTier(dob),
        expiry:          row.expiry,
        expiryStatus:    expiryStatus(row.expiry).state,
        jurisdiction:    row.jurisdiction || '',
        idType:          row.id_type || '',
        idCountry:       row.id_country || '',
        truliooVerified: !!row.trulioo_verified,
        registeredAt:    row.registered_at,
        updatedAt:       row.updated_at,
        lastSeenAt:      row.last_seen_at,
        scanCount:       row.scan_count,
        thumbnail:       decrypt(row.face_enc)
      };
    });
    const total = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
    res.json({ ok: true, total, returned: users.length, users });
  } catch (err) {
    console.error('[admin/users]', err);
    res.status(500).json({ ok: false, error: 'Internal error.' });
  }
});

app.delete('/api/admin/users/:token', requireAdmin, (req, res) => {
  const token = String(req.params.token || '').toUpperCase().trim();
  const row = db.prepare('SELECT token FROM customers WHERE token = ?').get(token);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found.' });
  db.prepare('DELETE FROM customers WHERE token = ?').run(token);
  res.json({ ok: true, deleted: token });
});

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT dob, dob_enc, expiry, scan_count FROM customers').all();
  let t18=0, t19=0, t25=0, expired=0, soon=0, scans=0;
  for (const r of rows) {
    const a = calculateAge(readDob(r));
    if (a >= 25) t25++; else if (a >= 19) t19++; else if (a >= 18) t18++;
    const e = expiryStatus(r.expiry).state;
    if (e === 'expired') expired++; else if (e === 'expiring_soon') soon++;
    scans += r.scan_count || 0;
  }
  const fraudHolds = db.prepare('SELECT COUNT(*) as n FROM customers WHERE fraud_hold = 1').get().n;
  const pendingDeletions = db.prepare('SELECT COUNT(*) as n FROM deletion_requests WHERE executed_at IS NULL').get().n;
  const retailerCount = db.prepare('SELECT COUNT(*) as n FROM retailers WHERE active = 1').get().n;
  const pendingRetailers = db.prepare('SELECT COUNT(*) as n FROM retailers WHERE active = 0').get().n;
  res.json({
    ok: true,
    stats: {
      total: rows.length, tier18Plus: t18, tier19Plus: t19, tier25Plus: t25,
      expired, expiringSoon: soon, totalScans: scans,
      fraudHolds, pendingDeletions, retailerCount, pendingRetailers,
      retentionDays: DATA_RETENTION_DAYS
    }
  });
});

// ─── ADMIN: RETAILER MANAGEMENT ────────────────────────────────────
app.get('/api/admin/retailers', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT retailer_id, business_name, contact_email, store_name, store_address,
           created_at, last_used_at, active
      FROM retailers ORDER BY created_at DESC
  `).all();
  res.json({ ok: true, retailers: rows });
});

app.post('/api/admin/retailers/:id/approve', requireAdmin, (req, res) => {
  const id = req.params.id;
  const result = db.prepare('UPDATE retailers SET active = 1 WHERE retailer_id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Retailer not found.' });
  auditLog('ADMIN', 'RETAILER_APPROVED', id, req);
  res.json({ ok: true });
});

app.post('/api/admin/retailers/:id/disable', requireAdmin, (req, res) => {
  const id = req.params.id;
  const result = db.prepare('UPDATE retailers SET active = 0 WHERE retailer_id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Retailer not found.' });
  auditLog('ADMIN', 'RETAILER_DISABLED', id, req);
  res.json({ ok: true });
});

// ─── ADMIN: AUDIT LOG ──────────────────────────────────────────────
app.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const rows = db.prepare(`
    SELECT id, ts, actor, action, target, ip, details
      FROM audit_log ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json({ ok: true, entries: rows });
});

app.get('/api/admin/audit-verify', requireAdmin, (_req, res) => {
  const result = verifyAuditChain();
  res.json({ ok: true, integrity: result });
});

// ─── ADMIN: PENDING DELETIONS ──────────────────────────────────────
app.get('/api/admin/deletion-requests', requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT * FROM deletion_requests WHERE executed_at IS NULL ORDER BY requested_at ASC
  `).all();
  res.json({ ok: true, requests: rows });
});

app.post('/api/admin/deletion-requests/:id/execute', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const dr = db.prepare('SELECT * FROM deletion_requests WHERE id = ?').get(id);
  if (!dr) return res.status(404).json({ ok: false, error: 'Request not found.' });
  if (dr.executed_at) return res.status(400).json({ ok: false, error: 'Already executed.' });

  db.prepare('DELETE FROM customers WHERE token = ?').run(dr.token);
  db.prepare('UPDATE deletion_requests SET executed_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
  auditLog('ADMIN', 'DELETION_EXECUTED', dr.token, req);
  res.json({ ok: true });
});

// Override admin user delete to log and respect deletion-pipeline
const oldDeletePath = '/api/admin/users/:token';

app.use('/api/*', (_req, res) => res.status(404).json({ ok: false, error: 'Unknown endpoint.' }));

// ── START ─────────────────────────────────────────────────────────
const certPath = path.join(__dirname, 'cert.pem');
const keyPath  = path.join(__dirname, 'key.pem');

function banner(scheme) {
  // Detect if running on a platform (Render, Railway, etc.) that provides SSL
  const isRender = process.env.RENDER === 'true';
  const isRailway = process.env.RAILWAY_STATIC_URL;
  const publicURL = process.env.RENDER_EXTERNAL_URL || 
                    (isRailway ? `https://${process.env.RAILWAY_STATIC_URL}` : null);
  
  const baseURL = publicURL || `${scheme}://localhost:${PORT}`;
  
  console.log(`\n  Mapleproof server running${publicURL ? ' (platform mode)' : ` (${scheme.toUpperCase()})`}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Customer kiosk : ${baseURL}/`);
  console.log(`  Retailer scan  : ${baseURL}/retailer`);
  console.log(`  Admin panel    : ${baseURL}/admin`);
  console.log(`  DB             : ${DB_PATH}`);
  console.log(`  Admin token    : ${ADMIN_TOKEN}`);
  console.log(`                   (saved in ${ADMIN_TOKEN_FILE})\n`);
  
  if (publicURL) {
    console.log(`  ✓ SSL provided by platform — camera will work!\n`);
  } else if (scheme === 'https') {
    console.log(`  ⚠️  Browser will warn about cert — click "Advanced" → "Proceed"\n`);
  } else {
    console.log(`  ⚠️  Camera disabled on HTTP. Generate a cert and restart.\n`);
  }
}

const isRender = process.env.RENDER === 'true';

if (!isRender && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const server = https.createServer({ 
    cert: fs.readFileSync(certPath), 
    key: fs.readFileSync(keyPath) 
  }, app);
  
  server.listen(PORT, '0.0.0.0');
  
  server.on('listening', () => {
    const addr = server.address();
    console.log(`[server] HTTPS server listening on ${addr.address}:${addr.port}`);
    banner('https');
  });
  
  server.on('error', (err) => {
    console.error('[server] HTTPS server error:', err);
    process.exit(1);
  });
} else {
  const server = app.listen(PORT, '0.0.0.0');
  
  server.on('listening', () => {
    const addr = server.address();
    console.log(`[server] HTTP server listening on ${addr.address}:${addr.port}`);
    banner('http');
  });
  
  server.on('error', (err) => {
    console.error('[server] HTTP server error:', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] Port ${PORT} is already in use. Exiting.`);
    }
    process.exit(1);
  });
}

// Process lifecycle handlers
process.on('SIGINT',  () => { 
  console.log('\n[server] Received SIGINT, shutting down gracefully…'); 
  if (db) db.close(); 
  process.exit(0); 
});

process.on('SIGTERM', () => { 
  console.log('\n[server] Received SIGTERM, shutting down gracefully…'); 
  if (db) db.close(); 
  process.exit(0); 
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  if (db) db.close();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled rejection at:', promise, 'reason:', reason);
});
