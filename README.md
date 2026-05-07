# Mapleproof — v9 (PIPEDA + AGCO compliance build)

This release transforms Mapleproof from a working prototype into a product that's defensible from a privacy/compliance standpoint. **Lawyer review of the legal text is still recommended before public launch** — but the technical and operational scaffolding is now in place.

## What changed in v9

### 1. Privacy & legal infrastructure

| New page | URL | Purpose |
|---|---|---|
| Privacy Policy | `/privacy` | Full PIPEDA-aligned policy: what we collect, how long, encryption details, your rights, breach notification, third parties, contact |
| Terms of Service | `/terms` | Eligibility, account responsibilities, what Mapleproof does/doesn't do, retailer obligations, disclaimers, liability cap, governing law |
| FAQ | `/faq` | Honest Q&A grouped: Basics, Privacy, How it works, For retailers |
| Retailers | `/retailers` | Pitch, compliance grid, AGCO inspection guidance, signup form |
| Delete | `/delete` | Customer self-service deletion (deletion request OR immediate) |

The customer app (`/app`) now has a **mandatory consent checkbox** before the "Process ID" button. The checkbox links to /privacy and /terms; without ticking it, the button stays disabled and the server rejects the registration.

### 2. Data security upgrades

**Encryption key from environment variable.** Previously stored in a file alongside the database (so a single backup leak compromised both). Now read from `MAPLEPROOF_ENCRYPTION_KEY` (base64 of 32 bytes). File-based fallback retained for local dev.

**Admin token from environment.** `MAPLEPROOF_ADMIN_TOKEN` env var.

**Privacy minimization (default ON).** The server no longer stores full ID front/back images. Only the cropped face (with circular mask), the AAMVA fields (encrypted), and the live-face crop are kept. Set `MAPLEPROOF_RETAIN_FULL_IDS=1` only if you have a regulatory reason to retain raw IDs.

**Tamper-evident audit log.** Every action (registrations, scans, deletions, retailer approvals) writes to `audit_log` with a SHA-256 chain — each row hashes the previous row's hash plus its own contents. Tampering breaks the chain. Admin can verify the chain on demand from the dashboard.

**Automatic data retention cleanup.** Customers inactive for `MAPLEPROOF_RETENTION_DAYS` (default 730 = 24 months) are auto-deleted. Audit logs are kept 5 years (long enough for compliance, short enough to limit exposure). Cleanup runs at startup and every 24 hours.

**Persistent (DB-backed) rate limiting.** Survives restarts. Customer registrations limited to 5/day and 10/hour per IP.

### 3. Retailer authentication

New `/api/retailer/signup` endpoint. Self-signup creates a retailer in pending state — admin must approve before the API key works. The API key is shown **once** at signup; the server only stores its SHA-256 hash.

The retailer scanner (`/retailer`) now has a **Settings** modal for pasting the API key (stored only in the browser's localStorage). Every scan sends `Authorization: Bearer mk_...` so audit logs know exactly which store performed each lookup.

Backward-compatible: scans without a key still work but log as "ANONYMOUS".

### 4. Rate limiting & fraud detection

**Multi-ID-same-IP detection.** If 3+ distinct ID hashes register from the same IP in 7 days, the new account is auto-flagged with `fraud_hold`, and retailer scans show a big red `⚠ FRAUD HOLD · REFUSE SALE` banner.

**Geographic anomaly detection.** Scan country differs from registration country → `GEO_ANOMALY` flag (informational, doesn't block).

**Manual fraud flag.** Cashiers can flag any pass via the new "⚠ Flag as fraud" button on the retailer result modal — calls `/api/retailer/flag-fraud` and the next scan returns a fraud hold.

### 5. OCR cross-check

`/api/register` accepts an `ocrFrontText` field (browser-side OCR of the ID front). The server compares it against the AAMVA barcode data on the back (DOB year, expiry year, last name) and stores `ocr_match_status` (match/partial/mismatch/not_run). Mismatches are flagged on retailer scans as `OCR_MISMATCH`.

> **Note:** `app.js` does not yet generate `ocrFrontText` — adding `tesseract.js` (~2 MB) is the missing piece. The server-side cross-check infrastructure is ready.

### 6. Better cashier UI

The retailer result modal is completely redesigned:

- **Big GREEN/AMBER/RED banner** at the top — 32px text, gradient background, instant decision signal
- **Twin photos side-by-side** — LIVE PHOTO vs ID PHOTO for visual comparison
- **Decisive banner copy** — "✓ VERIFIED · 19+", "⚠ FRAUD HOLD · REFUSE SALE", "⛔ ID EXPIRED", etc.
- **Flag-as-fraud button** beneath the result for cashier-initiated escalation
- **All new flag types** described in plain language (FRAUD_HOLD, OCR_MISMATCH, GEO_ANOMALY)

### 7. Marketing site upgrades

Hero rewritten around privacy: **"Your government ID, encrypted. Verified once. Used everywhere."** The privacy-first story is now the headline, not a tag below the fold.

New compliance badges section: PIPEDA Compliant · AES-256 Encryption · Canadian Hosting · Tamper-evident audit · AGCO Aware · Made in Canada.

Footer rewritten with proper Product / Legal / Contact columns and a prominent retailer-disclaimer about $100,000 AGCO penalties remaining the retailer's responsibility.

Nav now links to `/retailers`, `/faq`, `/privacy`, `/terms` instead of in-page anchors.

### 8. Admin dashboard

Now has tabs:

- **Customers** — original users grid (search/delete)
- **Retailers** — list, approve pending, disable active
- **Audit log** — last 200 entries + "Verify integrity" button (walks the hash chain and reports tampering)
- **Pending deletions** — review and execute customer deletion requests

New stats: fraud holds, pending deletions, active retailers, pending retailers.

---

## Environment variables for production

Set these in Render's dashboard (Environment tab):

```bash
# REQUIRED for production
MAPLEPROOF_ENCRYPTION_KEY=<base64-encoded 32 bytes>
MAPLEPROOF_ADMIN_TOKEN=<long random string>

# OPTIONAL (defaults shown)
MAPLEPROOF_RETENTION_DAYS=730
MAPLEPROOF_RETAIN_FULL_IDS=     # leave unset to discard full ID images (recommended)
```

To generate a key locally:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

To generate an admin token:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

⚠️ **If you change `MAPLEPROOF_ENCRYPTION_KEY`, all existing encrypted data becomes unreadable.** First-time setup: deploy without these env vars to let the server generate them and print them in the logs, then copy them into Render's Environment tab and redeploy.

---

## Deploy

```bash
cd C:\Users\gajan\Downloads\files

# Replace your old files with v9
# (optionally delete: trulioo files, old README — they're not in v9)

git add -A
git commit -m "v9: PIPEDA compliance, retailer auth, audit log, privacy minimization"
git push
```

Render auto-deploys on push. Build command: `npm install` · Start command: `node server.js`.

**Important Render setting:** upgrade from free tier to a paid Starter plan ($7/month) for persistent disk. On free tier, the database resets on every redeploy (~monthly), which makes the audit log unreliable.

---

## Testing checklist after deploy

- [ ] Visit `/` — verify privacy-first hero, compliance badges, footer with legal links
- [ ] Visit `/privacy`, `/terms`, `/faq`, `/retailers`, `/delete` — all render
- [ ] `/app` — try to process ID without ticking consent → button disabled, status text changes
- [ ] `/app` — full registration with consent ticked → succeeds, returns barcode
- [ ] `/retailer` — open Settings, paste API key from `/retailers` signup → save
- [ ] Scan a real pass without key → shows in admin audit log as `ANONYMOUS`
- [ ] Scan with key → shows in audit log as `retailer:r_...`
- [ ] Click "Flag as fraud" → next scan of same pass shows red FRAUD HOLD banner
- [ ] `/admin` → sign in with `MAPLEPROOF_ADMIN_TOKEN` value
- [ ] Audit log tab → "Verify integrity" returns ✓
- [ ] Retailers tab → pending retailer signups visible, can approve
- [ ] `/delete` → submit deletion request → appears in admin Deletions tab
- [ ] Execute the deletion → customer gone, audit logged

---

## What's still pending (for you and your lawyer)

1. **Lawyer review of `/privacy` and `/terms`** — the templates are PIPEDA-aligned but get them reviewed
2. **Update placeholder emails** — `hello@mapleproof.example` and `privacy@mapleproof.example` need to be real
3. **Add tesseract.js** for browser-side OCR (needed for OCR cross-check to actually run)
4. **Email notifications** — server writes to `deletion_requests` and creates pending retailers but doesn't send email (you'd add SendGrid/Resend integration here)
5. **Real-world fraud thresholds** — current `MULTI_ID_SAME_IP` threshold (3 in 7 days) is conservative; tune based on real traffic
6. **Get business insurance** before any retailer pilot — general liability + cyber liability
7. **Register with the OPC** as an organization handling personal info (free, paperwork only)
8. **Move to paid Render** with persistent disk — the audit log is meaningless if the DB resets monthly

---

## File inventory

```
mapleproof-v9/
├── server.js              ← Heavy rebuild: env-var keys, audit log, retailers, fraud, retention, OCR check
├── app.js                 ← Sends consent + version, no longer sends full ID images
├── app.html               ← Consent checkbox + topbar legal links
├── liveness.js            ← Unchanged from v8 (tight face crop with circular mask)
├── retailer.html          ← New big banner UI + twin photos + flag-fraud + settings modal
├── retailer.js            ← Bearer auth on every scan, flag-fraud, settings, new flag descriptions
├── admin.html             ← Tabs: Customers / Retailers / Audit / Deletions
├── admin.js               ← New loaders + verify-integrity + retailer approve/disable
├── index.html             ← Privacy-first hero, compliance badges, legal-link footer
├── styles.css             ← + consent row, big banner, twin photos, settings card, etc.
├── legal-styles.css       ← NEW shared style for /privacy /terms /faq /retailers /delete
├── privacy.html           ← NEW PIPEDA Privacy Policy
├── terms.html             ← NEW Terms of Service
├── faq.html               ← NEW Honest FAQ
├── retailers.html         ← NEW Retailer signup page
├── delete.html            ← NEW Customer self-service deletion
├── package.json           ← unchanged
├── .gitignore             ← unchanged
└── (logos + favicons)     ← unchanged
```
