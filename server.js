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

// AES-256 key
let ENCRYPTION_KEY;
if (fs.existsSync(KEY_FILE)) {
  ENCRYPTION_KEY = fs.readFileSync(KEY_FILE);
  if (ENCRYPTION_KEY.length !== 32) throw new Error('Encryption key file is corrupt.');
} else {
  ENCRYPTION_KEY = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, ENCRYPTION_KEY, { mode: 0o600 });
  console.log('[mapleproof] generated new encryption key at', KEY_FILE);
}

// Admin auth token
let ADMIN_TOKEN;
if (fs.existsSync(ADMIN_TOKEN_FILE)) {
  ADMIN_TOKEN = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
} else {
  ADMIN_TOKEN = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(ADMIN_TOKEN_FILE, ADMIN_TOKEN, { mode: 0o600 });
}

// ── DATABASE ──────────────────────────────────────────────────────
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      token           TEXT PRIMARY KEY,
      id_hash         TEXT NOT NULL UNIQUE,
      dob             TEXT,
      dob_enc         BLOB,
      expiry          TEXT NOT NULL,
      name_enc        BLOB,
      jurisdiction    TEXT,
      face_enc        BLOB NOT NULL,
      registered_at   TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      last_seen_at    TEXT,
      scan_count      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_customers_id_hash ON customers(id_hash);

    CREATE TABLE IF NOT EXISTS scan_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token        TEXT NOT NULL,
      scanned_at   TEXT NOT NULL,
      flags        TEXT,
      FOREIGN KEY (token) REFERENCES customers(token) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scan_log_token ON scan_log(token);
  `);

  // Migration: encrypt any legacy plaintext DOBs
  (() => {
    const cols = db.prepare("PRAGMA table_info(customers)").all();
    if (!cols.some(c => c.name === 'dob_enc')) db.exec('ALTER TABLE customers ADD COLUMN dob_enc BLOB');
    const legacy = db.prepare(`
      SELECT token, dob FROM customers
       WHERE (dob_enc IS NULL OR length(dob_enc)=0)
         AND dob IS NOT NULL AND dob != ''
    `).all();
    if (legacy.length) {
      const upd = db.prepare('UPDATE customers SET dob_enc = ?, dob = NULL WHERE token = ?');
      db.transaction(rows => { for (const r of rows) upd.run(encrypt(r.dob), r.token); })(legacy);
      console.log(`[mapleproof] migrated ${legacy.length} legacy DOB(s) to encrypted storage`);
    }
  })();
  
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

// ── EXPRESS ───────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));

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
app.get('/',         (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/retailer', (_req, res) => res.sendFile(path.join(__dirname, 'retailer.html')));
app.get('/admin',    (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Rate limiting
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= limit) { buckets.set(key, recent); return false; }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, v] of buckets) {
    const fresh = v.filter(t => t > cutoff);
    if (fresh.length === 0) buckets.delete(k); else buckets.set(k, fresh);
  }
}, 60_000).unref();

function requireAdmin(req, res, next) {
  if (!rateLimit(`admin:${req.ip}`, 30, 60_000)) return res.status(429).json({ ok: false, error: 'Too many requests.' });
  const auth = req.headers.authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tok || !timingSafeEq(tok, ADMIN_TOKEN)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  next();
}

// ── /api/register ────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  if (!rateLimit(`reg:${req.ip}`, 30, 60_000))
    return res.status(429).json({ ok: false, error: 'Too many registrations. Try again shortly.' });

  try {
    const { idNumber, dob, expiry, name, jurisdiction, faceImageData } = req.body || {};
    if (!idNumber || !dob || !expiry || !faceImageData)
      return res.status(400).json({ ok: false, error: 'Missing required fields.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob))    return res.status(400).json({ ok: false, error: 'DOB must be YYYY-MM-DD.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return res.status(400).json({ ok: false, error: 'Expiry must be YYYY-MM-DD.' });
    if (typeof faceImageData !== 'string' || !faceImageData.startsWith('data:image/'))
      return res.status(400).json({ ok: false, error: 'Face image must be a data: URL.' });
    if (faceImageData.length > 6_000_000)
      return res.status(413).json({ ok: false, error: 'Face image too large.' });

    const age = calculateAge(dob);
    if (age < 18) return res.status(403).json({ ok: false, error: `Customer is ${age} — under the minimum tier.` });
    const exp = expiryStatus(expiry);
    if (exp.state === 'expired') return res.status(403).json({ ok: false, error: 'Government ID is expired.' });

    const idHash = hashId(idNumber);
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT token, registered_at FROM customers WHERE id_hash = ?').get(idHash);

    let token, action;
    if (existing) {
      // ── Same person re-registering: REUSE existing token (no duplicates allowed) ──
      token = existing.token;
      action = 'updated';
      db.prepare(`
        UPDATE customers
           SET dob_enc = ?, expiry = ?, name_enc = ?, jurisdiction = ?,
               face_enc = ?, updated_at = ?, dob = NULL
         WHERE token = ?
      `).run(encrypt(dob), expiry, encrypt(name || ''), jurisdiction || '',
             encrypt(faceImageData), now, token);
    } else {
      do { token = generateToken(); }
      while (db.prepare('SELECT 1 FROM customers WHERE token = ?').get(token));
      action = 'created';
      db.prepare(`
        INSERT INTO customers
          (token, id_hash, dob_enc, expiry, name_enc, jurisdiction,
           face_enc, registered_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(token, idHash, encrypt(dob), expiry, encrypt(name || ''),
             jurisdiction || '', encrypt(faceImageData), now, now);
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
        ageBadge: ageBadge(age),
        verified: age >= LEGAL_AGE,
        jurisdiction: jurisdiction || '',
        expiry,
        expiryStatus: exp.state,
        registeredAt: existing ? existing.registered_at : now
      }
    });
  } catch (err) {
    console.error('[register]', err);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

// ── /api/pass/:token (retailer scan) ─────────────────────────────
app.get('/api/pass/:token', (req, res) => {
  if (!rateLimit(`pass:${req.ip}`, 240, 60_000))
    return res.status(429).json({ ok: false, error: 'Too many lookups.' });

  try {
    const token = String(req.params.token || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{6,16}$/.test(token))
      return res.status(400).json({ ok: false, error: 'Invalid barcode format.' });

    const row = db.prepare(`
      SELECT token, dob, dob_enc, expiry, jurisdiction, face_enc,
             registered_at, updated_at, last_seen_at, scan_count
        FROM customers WHERE token = ?
    `).get(token);

    if (!row) return res.status(404).json({ ok: false, error: 'No matching pass found.' });

    // ── Age tier computed LIVE (auto-updates with birthday) ──
    const dob = readDob(row);
    const age = calculateAge(dob);
    const exp = expiryStatus(row.expiry);

    const flags = [];
    if (age < LEGAL_AGE) flags.push('UNDER_LEGAL_AGE');
    if (age >= 19 && age < 21) flags.push('CLOSE_TO_LIMIT');
    if (exp.state === 'expired') flags.push('ID_EXPIRED');
    if (exp.state === 'expiring_soon') flags.push('ID_EXPIRING_SOON');
    if (Date.now() - new Date(row.registered_at).getTime() < 5 * 60_000) flags.push('JUST_REGISTERED');

    const now = new Date().toISOString();
    db.prepare('UPDATE customers SET last_seen_at = ?, scan_count = scan_count + 1 WHERE token = ?').run(now, token);
    db.prepare('INSERT INTO scan_log (token, scanned_at, flags) VALUES (?, ?, ?)').run(token, now, JSON.stringify(flags));

    return res.json({
      ok: true,
      publicRecord: {
        ageBadge:     ageBadge(age),
        verified:     age >= LEGAL_AGE && exp.state !== 'expired',
        expiry:       row.expiry,
        expiryStatus: exp.state,
        expiryDays:   exp.days,
        jurisdiction: row.jurisdiction || '',
        faceImage:    decrypt(row.face_enc),
        registeredAt: row.registered_at,
        lastSeenAt:   row.last_seen_at,
        scanCount:    row.scan_count + 1,
        flags
      }
    });
  } catch (err) {
    console.error('[pass]', err);
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
        token:        row.token,
        ageBadge:     ageBadge(age),
        age,
        nextTierIn:   daysToNextTier(dob),
        expiry:       row.expiry,
        expiryStatus: expiryStatus(row.expiry).state,
        jurisdiction: row.jurisdiction || '',
        registeredAt: row.registered_at,
        updatedAt:    row.updated_at,
        lastSeenAt:   row.last_seen_at,
        scanCount:    row.scan_count,
        thumbnail:    decrypt(row.face_enc)
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
  res.json({ ok: true, stats: { total: rows.length, tier18Plus: t18, tier19Plus: t19, tier25Plus: t25, expired, expiringSoon: soon, totalScans: scans } });
});

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

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const server = https.createServer({ 
    cert: fs.readFileSync(certPath), 
    key: fs.readFileSync(keyPath) 
  }, app);
  
  server.listen(PORT, '0.0.0.0', () => {
    banner('https');
  });
  
  server.on('error', (err) => {
    console.error('[server] HTTPS server error:', err);
    process.exit(1);
  });
} else {
  const server = app.listen(PORT, '0.0.0.0', () => {
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

// Keep the process alive
process.on('SIGINT',  () => { 
  console.log('\n[server] Received SIGINT, shutting down gracefully…'); 
  db.close(); 
  process.exit(0); 
});

process.on('SIGTERM', () => { 
  console.log('\n[server] Received SIGTERM, shutting down gracefully…'); 
  db.close(); 
  process.exit(0); 
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  db.close();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled rejection at:', promise, 'reason:', reason);
});
