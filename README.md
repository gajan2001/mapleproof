# Mapleproof — v14 (switchable: Trulioo API flow OR Web SDK flow)

v14 keeps everything from v13 and adds the **Trulioo Web SDK / shortCode flow** as a switchable alternative. One environment variable picks which one runs.

## The two flows

**API flow** (`TRULIOO_FLOW=api`, the default — this is v13's behaviour)
Your own UI captures the ID document (front/back) and the liveness selfie, your server uploads them to the Trulioo Customer API and gets the result. You control the entire look & feel.

**Web SDK flow** (`TRULIOO_FLOW=sdk`)
Your server mints a single-use **shortCode** (authorize → create transaction → `POST /customer/handoff`). The browser loads Trulioo's official **`@trulioo/docv` Web SDK** from the CDN and hands it the shortCode; Trulioo renders its own guided document-capture + selfie/liveness experience (themed to the Mapleproof gold). When it finishes, your server confirms the result by transaction id. After Trulioo verifies, the app still captures a quick Mapleproof liveness selfie purely for the pass photo, then issues the pass.

Both flows use the same licence-key → accessToken backend and the same simulation fallback, so the public trial works in either mode without keys.

## What to set in Render.com

Open your service on Render → **Environment** tab → **Add Environment Variable**, then **Save Changes** (Render redeploys automatically). The only things you ever need:

| Variable | Required? | Value | Effect |
|---|---|---|---|
| `TRULIOO_LICENSE_KEY` | To go live | Your Customer API licence key from the Trulioo portal | Switches from SIMULATION to real Trulioo verification |
| `TRULIOO_FLOW` | Optional | `api` (default) or `sdk` | Chooses the integration style above |
| `TRULIOO_API_BASE` | Optional | defaults to `https://verification.trulioo.com` | Only if Trulioo gives you a different base URL |
| `TRULIOO_API_VERSION` | Optional | defaults to `2.4` | API version header |

Existing variables stay as they are: `MAPLEPROOF_ENCRYPTION_KEY`, `MAPLEPROOF_ADMIN_TOKEN` (and `RESET_DB=1` only if you want to wipe the database once).

### Exactly what to do on Render, step by step

1. Push the v14 code to your GitHub repo (replace all files, commit).
2. In Render, your service auto-builds. (No build-command changes — still `npm install` / `node server.js`, Node pinned `>=18 <24`.)
3. Go to **Environment** → add `TRULIOO_LICENSE_KEY` with your key. To use the SDK experience, also add `TRULIOO_FLOW` = `sdk`. Click **Save Changes**.
4. Render redeploys. Open the logs — you'll see `Trulioo mode: LIVE ✓ · flow: API` (or `SDK`).
5. Until you add the key it stays in SIMULATION so the trial keeps working — no broken site at any point.

To test live without a contract, Trulioo's **Demo License** (docs.verification.trulioo.com/sdk/demo-license) gives a key you can drop into `TRULIOO_LICENSE_KEY` for end-to-end test responses.

## Things to confirm against your Trulioo portal (isolated & commented)

- `truliooVerifyDocument` / `truliooCreateShortCode` in `server.js` — the authorize header name (`LicenseKey`), document-type enum values (`TRULIOO_DOC_TYPE`), and the result `status` strings counted as "verified".
- The Web SDK CDN pin: `@trulioo/docv/+esm` (latest). Pin a version if you prefer (`@trulioo/docv@2.8.1/+esm`).
- BIPA/consent: handled via the consent box + `consent` flag; review with counsel for production.

## Honest notes

Same as before: no one can run *live* Trulioo without your account's licence key. Both flows are real and complete, validated to run in simulation today and flip to live with `TRULIOO_LICENSE_KEY`. Dependencies remain just `express` + `better-sqlite3` (the Web SDK loads from CDN in the browser; the API calls use Node's built-in HTTPS), so nothing new can break the Render build. Exact logo, black/gold theme, launch gate, self-healing DB, Node pin — all unchanged.

---

---



**This is the integration you asked for.** Trulioo verifies the person from their **actual ID document** *and* a **live selfie** — not just a face scan. It uses Trulioo's official **Customer API**, which is purpose-built for developers to do exactly this.

## Yes — Trulioo has this for developers

Confirmed from Trulioo's developer docs (`docs.verification.trulioo.com`): the **Customer API** creates a transaction configured for **document verification + selfie liveness**, accepts uploaded images (front/back of ID + a live selfie), runs document authenticity + iBeta-certified biometric face-match/liveness, and returns the result with the extracted person data. That's precisely "ask for the ID, then do the live check."

## The flow now

```
Home
  └─ Step 1: Verify your ID
        • pick ID type (the 7 Canadian documents)
        • photograph the FRONT of the ID (and BACK if applicable)
  └─ Step 2: Liveness check (the existing active selfie check)
  └─ Trulioo Customer API runs server-side:
        authorize → create transaction (document + selfie) →
        upload front/back/live → verify → poll result
  └─ Pass issued only if Trulioo verifies the document AND the face match
```

The ID document images are sent to **Trulioo** for verification and are **never stored by Mapleproof** — only the verified selfie + the Trulioo reference are kept, exactly as before.

## LIVE vs SIMULATION (one env var)

| Mode | Trigger | Behaviour |
|---|---|---|
| **LIVE** | `TRULIOO_LICENSE_KEY` set | Real Trulioo Customer API verification end-to-end |
| **SIMULATION** | key absent (the public trial) | Clearly-flagged synthetic pass so the demo still works |

Optional env vars: `TRULIOO_API_BASE` (defaults to `https://verification.trulioo.com`), `TRULIOO_API_VERSION` (defaults to `2.4`).

The mode is logged on boot and shown in the UI as a "Secured by Trulioo" / "Trulioo · Simulation (trial)" badge — always honest.

## Server endpoints (all server-side; licence key never reaches the browser)

- `GET  /api/trulioo/config` — tells the frontend live vs simulation
- `POST /api/trulioo/document-verify` — receives the ID image(s) + selfie, runs the full Customer API workflow (`/authorize/customer` → `/customer/transactions` → `/customer/transactions/documents` ×N → `/customer/transactions/verify` → `GET /customer/transactions/{id}`), returns `{ verified, person, reference }`

`/api/register` still requires `truliooVerified` and treats ID detail fields as optional (Trulioo owns them); the pass shows the verified selfie + "Trulioo Verified".

## Going live (when your Trulioo account is ready)

1. Get your **Customer API licence key** from the Trulioo Developer Portal.
2. In Render → Environment, set `TRULIOO_LICENSE_KEY` to that value. Redeploy.
3. That's it — the simulation is replaced by real verification automatically.
4. Confirm two account-specific details against your portal's API Reference and adjust if needed (both are isolated and commented in `server.js`): the document-type enum values in `TRULIOO_DOC_TYPE`, and the result `status` strings treated as "verified" in `truliooVerifyDocument`. Trulioo's notice/consent (BIPA) requirement is handled via the `consent` flag and the in-app consent box; review with counsel for production.

## Honest notes

- No one can run *live* Trulioo without your account's licence key. What's shipped is the complete, real Customer API integration, validated to run in simulation today and flip to live with one env var.
- Dependencies are back to just `express` + `better-sqlite3` (the API calls use Node's built-in `https`), so nothing new can break the Render build.
- Node pin (`>=18 <24`), self-healing DB, the exact gold logo, black/gold theme, and launch gate are all unchanged from v11/v12.

---

---



This release replaces the OCR / manual-entry identity step with a **real Trulioo EmbedID integration**. Trulioo now owns ID capture, document verification, and the biometric check. Your Mapleproof pass still shows the verified selfie + a "Trulioo Verified" badge.

## How it works

The integration is **complete and real** — it runs live the moment your Trulioo keys are present, and falls back to a clean built-in simulation so the public trial keeps working with **zero code changes**.

**Two env vars control everything** (set them in Render → Environment):

| Variable | What it is |
|---|---|
| `TRULIOO_API_KEY` | Secret API key from your Trulioo Developer Portal. Backend only — never sent to the browser. |
| `TRULIOO_EMBEDID_PUBLIC_KEY` | The EmbedID public key (frontend). |
| `TRULIOO_API_BASE` | *(optional)* Trulioo API base URL. Defaults to production. |

- **Both set → LIVE mode.** The real Trulioo EmbedID widget (`https://js.trulioo.com/latest/main.js`) renders in the verification step. The official `trulioo-embedid-middleware` (an `optionalDependency`) is mounted server-side to mint access tokens securely. After the user completes Trulioo's flow, the server confirms the result via the Trulioo API using the experience transaction id.
- **Not set → SIMULATION mode.** A branded "Trulioo Identity Verification" panel runs the same 4 steps and returns a clearly-flagged synthetic pass. The audit log records it as `TRULIOO_VERIFY_SIMULATED`.

The mode is auto-detected and shown in the server logs on boot, and the UI shows a "Secured by Trulioo" / "Trulioo · Simulation (trial)" badge so it's always honest about which mode it's in.

## What changed

- **New customer flow:** Home → **Trulioo identity verification** → liveness selfie (for the pass photo) → pass. The user no longer uploads an ID or types anything — Trulioo handles document capture and verification.
- **Removed:** the Tesseract OCR pipeline, the 7-field manual review form, the worldwide/ID-type dropdown, the in-browser ID-photo handling. (Trulioo's own flow covers all document types it supports for your account.)
- **Server:** new `/api/trulioo/config`, `/trulioo-api/...` token mount (real middleware in live, synthetic in sim), and `/api/trulioo/result` (real Trulioo transaction lookup in live, simulated pass in sim). `/api/register` now requires `truliooVerified` but treats ID detail fields as optional, since Trulioo owns them. The old `/api/trulioo-verify` still works in simulation for backwards-compat.
- **`package.json`:** `trulioo-embedid-middleware` added as an **optionalDependency** so a failed/again-incompatible install can never break your deploy (it's only required at runtime in live mode).

## Going live (when your Trulioo account is ready)

1. In the Trulioo Developer Portal, get your `TRULIOO_API_KEY` and `TRULIOO_EMBEDID_PUBLIC_KEY`, and use the Author tool to style the EmbedID experience to match the gold/black theme.
2. In Render → Environment, add those two variables.
3. Redeploy. That's it — the UI switches from the simulation panel to the real Trulioo widget automatically.
4. Confirm the result-lookup endpoint path. The code calls `GET /verifications/v1/transactionrecord/<id>` on the Trulioo API; depending on your account/region/product this path or the result field names may differ. It's isolated to one function (`/api/trulioo/result` in `server.js`) with a comment marking exactly the line to adjust — verify it against your portal's API Reference.

## Honest caveats

- I can't ship working *live* verification without your Trulioo account/keys — nobody can. What's shipped is the full, real integration wired end-to-end, validated to run in simulation today and flip to live via env vars.
- The `trulioo-embedid-middleware` npm package is community-maintained and not very active. The integration is built so that if it's missing or fails to install, the trial is unaffected (optionalDependency + lazy require), and live mode shows a clear "run npm i trulioo-embedid-middleware" message rather than crashing.
- Trulioo EmbedID's exact client constructor options and the result API shape can change between account tiers; the two integration points (`startTruliooLive` in `app.js`, `/api/trulioo/result` in `server.js`) are small and clearly commented for you to confirm against your live portal docs.
- The consent box is pre-checked for trial smoothness; for production you'll likely want explicit opt-in.

---

---



**Bug:** a correct Ontario licence (and other valid IDs) could be rejected with *"This does not look like a …"*.

**Cause:** the upload validator hard-rejected the ID unless browser OCR cleanly matched type keywords. Real IDs have holographic overlays, tiny security fonts, glare and angles, so Tesseract's text is often too noisy to keyword-match — even on a perfectly valid document.

**Fix:** keyword matching no longer rejects anything — it only sets an internal high/low confidence flag. The upload is now accepted as long as it's plausibly a photo-ID document (has a face, **or** dates, **or** government/document text). Face detection on the ID also got more forgiving (two detection passes at lower thresholds, since ID portraits are small/stylised). The only hard rejections now are clear non-documents: a blank image/object, or an obvious plain selfie with no document text at all. The review step still asks the user to confirm/correct whatever was extracted — that remains the safety net.

Net effect: valid IDs pass through to the review screen; only genuinely wrong uploads (random photo, selfie, screenshot of nothing) are refused.

---

---

# Mapleproof — v11.1 (exact logo + OCR auto-extract + Canadian IDs)

Updates on top of v11:

### Exact logo
The logo is now the **real Mapleproof maple-M**, extracted directly from your reference image (not hand-drawn) and recoloured to a clean gold gradient. Used as `logo-mark.png` everywhere — nav, hero, footer, favicons, in-app, retailer, admin. A `logo-full.png` (mark + wordmark) is also included.

### Upload-and-read ID flow (no manual typing)
The user no longer types their details. Instead:

1. **Pick the ID type** (the 7 accepted Canadian documents — see below)
2. **Upload one photo of the ID** — the upload button stays locked until a type is chosen
3. The browser runs **Tesseract.js OCR** + **face detection** and:
   - **Rejects non-IDs immediately** — if the image has no face photo, no readable text, or doesn't match the chosen document type, it's refused with a clear message and nothing is kept
   - **Rejects non-images** up front (wrong file type / too large)
   - **Extracts** name, date of birth, document number, and expiry (passport uses MRZ parsing; others use labelled-field + date heuristics)
4. **Review step** — the extracted details are shown pre-filled. If anything couldn't be read confidently, the user is asked to **complete/correct it manually** (the validation fallback you asked for). They must confirm before continuing.
5. Liveness selfie → **face match against the ID photo** → simulated Trulioo → pass

The ID photo is still **used only in the browser** (read + face match) and **never uploaded or stored** — only the verified selfie + match score persist.

### The 7 accepted ID types
Ontario Driver's Licence (with photograph) · Canadian Passport · Canadian Citizenship Card (with photo) · Canadian Armed Forces Identification Card · Secure Certificate of Indian Status (Government of Canada) · Permanent Resident Card (Government of Canada) · Ontario Photo Card (Photo Card Act).

`server.js` `VALID_ID_TYPES` and the in-app labels were updated to exactly this list; the old worldwide list and the country dropdown were removed (country is fixed to Canada).

### Files changed in v11.1
`app.html` (Canadian ID dropdown, upload+OCR UI, review block, Tesseract script), `app.js` (OCR pipeline: `validateIsId`, `extractFields`, `parseMRZ`, reject logic, review flow), `server.js` (7 Canadian `VALID_ID_TYPES`), `styles.css` (review/upload states), all logo/favicon assets (exact logo).

> Note on OCR: Tesseract runs fully in the browser. Real-world ID photos vary, so the **review/confirm step is always shown** — extracted values are a starting point the user verifies. This is intentional and matches your "if anything not clear, ask the user to validate manually" requirement. For production-grade extraction you'd later route the image through Trulioo's document API (the simulated hook is already there).

---

---



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
