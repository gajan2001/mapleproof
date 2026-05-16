# Mapleproof — v11 (premium black & gold theme + launch gate)

**v11 is a visual + structural release on top of v10.** All the v10 logic (worldwide IDs, simulated Trulioo, selfie-only pass) is unchanged and still works. What changed:

## New in v11

### 1. Premium black & gold theme
The entire site was redesigned to a luxury dark aesthetic — pure black backgrounds, gold-gradient accents, the nightclub marble backdrop, and the "SHOW LESS. PROVE MORE." tagline. Applied across the landing page, the verification app, the retailer scanner, the admin panel, and all legal pages.

### 2. New maple-M logo
A brand-new gold maple-leaf-with-M logo (`logo-mark.svg` — crisp vector, used inline on the main pages; plus PNG fallbacks/favicons). **All previous logos were deleted** (`logo-shield*`, `logo-horizontal*`, old `logo-leaf-mark`, old favicons) and replaced.

### 3. "Under development" launch gate
- **`/` now shows a premium "Launching Soon" page** (`coming-soon.html`) — NOT the marketing site.
- It has an **"Enter Trial Version →"** button that takes visitors to **`/home`** (the working trial).
- Routing:
  - `/` → `coming-soon.html` (the gate — first thing everyone sees)
  - `/home` → `index.html` (the real marketing landing — premium black/gold)
  - `/app` → the working v10 verification flow (now black/gold themed)
  - everything else (`/retailer`, `/admin`, `/privacy`, …) unchanged

### 4. New background assets
Three optimized images from your reference pack: `bg-nightclub.jpg` (global background), `bg-products.jpg` (hero), `bg-card-phone-opt.jpg` (privacy section).

## Files changed/added in v11

```
coming-soon.html   ← NEW: the under-development gate (premium black/gold)
index.html         ← REBUILT: premium black/gold marketing landing
logo-mark.svg      ← NEW: vector maple-M logo
logo-mark.png      ← NEW: raster fallback
favicon.png/-32    ← REPLACED with new gold mark
bg-*.jpg           ← NEW: background images from your refs
styles.css         ← black/gold theme override appended (app/retailer/admin)
legal-styles.css   ← black/gold theme override appended (legal pages)
server.js          ← routing: "/" → gate, "/home" → marketing
app.html           ← brand link → /home (logic & v10 elements unchanged)
```

**Deleted:** `logo-shield.png`, `logo-shield-transparent.png` (old), `logo-horizontal.png`, `logo-horizontal-transparent.png`, old `logo-leaf-mark.png`, old favicons — all replaced with the new gold mark.

> Note: `logo-leaf-mark.png` and `logo-shield-transparent.png` filenames still exist (regenerated with the NEW gold logo) so the existing `<img>` tags in app/retailer/admin keep working without markup changes.

## Deploy (same as before)

1. Upload all v11 files to GitHub (replace everything)
2. Render auto-redeploys. The self-healing DB migration + Node pin (`>=18 <24`) from v10 are still in place
3. If you want a clean DB, set `RESET_DB=1`, deploy, then remove it

After deploy:
- `mapleproof.onrender.com/` → the new "Launching Soon" gate
- Click **Enter Trial Version** → premium landing → **Get My Pass** → working flow

---

---

# Mapleproof — v10 (worldwide IDs + Trulioo verification)

This release makes Mapleproof work with **identity documents from any country** — passports, national ID cards, residence permits, driver's licenses — and adds an identity-verification step routed through **Trulioo** (currently **simulated** — see the warning below).

It also changes how the pass works: **the ID photo is never stored.** Only the verified selfie and the face-match percentage are kept.

---

## ⚠️ IMPORTANT: Trulioo is SIMULATED

You have not signed a contract with Trulioo yet, so this build **does not actually call Trulioo's API.** The endpoint `/api/trulioo-verify` runs basic sanity checks (age, expiry, required fields) and then returns a **fake "verified" response** with a synthetic reference number like `TRL-SIM-A1B2C3D4`.

Every simulated verification is honestly flagged:
- The API response includes `"simulated": true` and `"datasource": "SIMULATED"`
- The audit log records the action as `TRULIOO_VERIFY_SIMULATED` with the note `"MOCK — not a real Trulioo call"`

**When you sign with Trulioo:** the only file you change is `server.js` — replace the body of the `/api/trulioo-verify` handler with a real call to Trulioo's GlobalGateway "verify" API. The browser code, the database, and the rest of the flow stay exactly the same, because the request/response shape was kept deliberately simple.

---

## What changed in v10

### 1. Worldwide ID support — manual entry, no barcode scanning

The old flow scanned the PDF417 barcode on the back of Ontario driver's licenses. That only works for North American licenses — passports don't have PDF417 barcodes.

v10 replaces barcode scanning with a **manual details form**:

- **ID Type dropdown:** Passport, Driver's License, National ID Card, State/Provincial ID, Residence Permit
- **Name fields:** First/Given name, Last/Family name
- **Date of birth, ID/document number, expiry date**
- **Country of issue dropdown** — 25 countries plus "Other"
- **ID photo upload** — one clear photo showing the person's face

All the PDF417/ZXing barcode-scanning code is gone. The `@zxing/library` CDN script was removed from `app.html`.

### 2. The ID photo is never stored

This is the big privacy change. In v10:

- The uploaded ID photo stays **in the browser only**
- It is used **once** — to run the face-match against the live selfie (face-api.js, browser-side)
- After matching, it is **discarded.** It is never uploaded to the server, never written to the database
- The server's `/api/register` endpoint doesn't even accept an ID photo field anymore

What the server stores: the **verified selfie**, the **face-match score** (a number 0–1), the ID details (encrypted), and the Trulioo reference.

### 3. Redesigned pass card

The pass used to show twin photos (LIVE + ID side by side). Now it shows:

- **One photo** — the verified selfie
- **A large face-match percentage** with a colour-coded note (green ≥70% "strong", amber ≥55% "review", red <55% "low")
- **A "✓ Trulioo Verified" badge**
- **ID Type** in the metadata row (instead of jurisdiction)

The downloadable PNG pass was updated to match.

### 4. Trulioo verification step in the flow

The customer flow is now:

```
Home  →  ID details (any country)  →  Liveness check  →  Trulioo verification  →  Pass
```

During the "saving" screen, the user sees a live progress animation:
1. Connecting to Trulioo identity network…
2. Verifying document authenticity…
3. Cross-checking global watchlists…
4. Verification complete ✓

(Again — this is simulated. The animation is real; the Trulioo call behind it is not, yet.)

The server **refuses to issue a pass** unless `truliooVerified` is true — so the verification step can't be skipped.

### 5. Retailer scanner updated

- The result modal shows **one photo** (the verified selfie), not twin photos
- New flag: `NO_TRULIOO_VERIFICATION` — shown if a pass somehow lacks Trulioo verification
- The old `OCR_MISMATCH` flag was removed (no barcode = no OCR cross-check)

### 6. Database schema additions

New columns on the `customers` table (auto-migrated on startup):

| Column | Purpose |
|---|---|
| `id_type` | passport / drivers_license / national_id / state_id / residence_permit |
| `id_country` | ISO country code of the issuing country |
| `trulioo_verified` | 1 if identity verification passed |
| `trulioo_reference` | the reference returned by `/api/trulioo-verify` |

The old `id_face_enc`, `id_front_enc`, `id_back_enc` columns still exist in the schema but are **always written as NULL** now — ID images are never stored.

---

## Files changed from v9

```
app.html      ← ID type dropdown + manual entry form + single-photo pass + Trulioo progress UI
app.js        ← FULL REWRITE: no barcode scanning, manual form, Trulioo call, selfie-only pass
server.js     ← new /api/trulioo-verify endpoint, rewritten /api/register, schema +4 columns,
                pass lookup no longer returns ID photo, NO_TRULIOO_VERIFICATION flag
styles.css    ← + form styles, Trulioo progress animation, single-photo pass card
retailer.html ← twin photos → single "VERIFIED SELFIE"
retailer.js   ← removed ID-photo handling, updated flag descriptions
admin.js      ← (unchanged — still works)
```

Unchanged: `liveness.js`, `index.html`, all legal pages (`privacy.html`, `terms.html`, `faq.html`, `retailers.html`, `delete.html`), `legal-styles.css`, logos, `package.json`.

> **Note:** the legal pages still describe the Ontario-licence / PDF417 flow in places. They should be updated to mention worldwide IDs and Trulioo before a real launch — and your lawyer should review the Trulioo data-sharing language. This wasn't done automatically because legal copy needs human review.

---

## Deploy

This is a **new database schema**, so you need a fresh database (same as the v9→ jump).

1. Replace all files in your GitHub repo with these v10 files
2. Commit and push (or upload via GitHub web)
3. On Render, the schema auto-migrates on startup — but because v9 data has a different shape, do a clean start:
   - Render dashboard → your service → **Manual Deploy → Clear build cache & deploy**
   - Or use the `RESET_DB=1` environment-variable trick from before, then remove it

4. Environment variables stay the same as v9:
   - `MAPLEPROOF_ENCRYPTION_KEY`
   - `MAPLEPROOF_ADMIN_TOKEN`
   - `>=18 <24` is already pinned in `package.json` engines (keeps Render off Node 26)

---

## Testing checklist after deploy

- [ ] `/app` → home → "Get my pass"
- [ ] ID type dropdown shows all 5 options
- [ ] Try to continue with the form half-filled → button stays disabled, status text guides you
- [ ] Fill everything, tick consent → "Continue to verification" enables
- [ ] Liveness check runs as before
- [ ] "Saving" screen shows the 4-step Trulioo progress animation
- [ ] Pass appears with: one selfie photo, a face-match %, "✓ Trulioo Verified" badge, ID Type in metadata
- [ ] Download pass → PNG has the single selfie + match score
- [ ] `/retailer` → scan the pass → result shows ONE photo (verified selfie), not two
- [ ] `/admin` → Customers tab → users still list correctly
- [ ] `/admin` → Audit log → you can see `TRULIOO_VERIFY_SIMULATED` entries
- [ ] Verify a passport (no expiry barcode needed — it's all manual now)

---

## What's still pending

1. **Sign with Trulioo**, then swap the `/api/trulioo-verify` handler body for a real API call
2. **Update legal pages** — `privacy.html` and `faq.html` still reference Ontario licences / PDF417; add worldwide-ID and Trulioo data-sharing language, and get a lawyer to review
3. **Age tiers are still Ontario-based** (19+/25+) — if you verify IDs from countries with an 18+ drinking age, the tier logic in `server.js` (`ageBadge()`) needs per-country rules
4. **ID-number uniqueness across countries** — two different countries could theoretically issue the same document number. If that matters, include the country code in the `id_hash` input
5. Everything from the v9 pending list still applies (paid Render tier for persistent disk, real contact emails, business insurance, etc.)
