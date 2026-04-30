# Mapleproof — Final build

Everything you asked for, in one folder. Cost: **$0/month** (Render free tier + browser-side libraries).

---

## What's new in this build

1. **`landing.html`** — standalone marketing page matching your reference design (Image 3). Hero, trust strip, "How it works" for Users/Retailers, 5 industries, rewards section. **"Get My Pass" buttons link to https://mapleproof.onrender.com/**.
2. **Logos integrated** — the maple-leaf shield is now used in the browser tab (favicon), the topbar of every page, and the home-screen hero. Generic SVG marks removed.
3. **ID front + back upload** — the customer can now upload two photos of their licence instead of (or in addition to) live PDF417 scanning. Much faster on slow phones. Live camera is still there as an opt-in toggle.
4. **Selfie ↔ ID photo matching** (like Uber driver verification) — runs on the user's own device using `face-api.js`. Free, no API costs, no server processing. The match score (0–100%) is shown on the pass card and in the retailer's view.
5. **Bigger barcode** — Code 128 bars are now `3.4px` wide (was `2.4px`) with a wider quiet zone. This fixes the "retailer scanner can't read the generated pass" issue.
6. **Retailer image-upload fallback** — third mode added. If the camera scan fails, the cashier can take or pick a photo of the customer's pass.
7. **Trulioo removed** — code, references, and setup docs deleted from this build.

---

## Files (15 total)

### App (replaces what's on your Render service)
- `server.js` — adds `id_front_enc`, `id_back_enc`, `face_match_score`, `face_match_at` columns with auto-migration; `/api/register` accepts `idFrontImage`, `idBackImage`, `faceMatchScore`; `/api/pass/:token` returns `faceMatchScore` and `faceMatchStatus`
- `app.js` — upload mode, face-matching, larger barcode rendering, mode toggle
- `retailer.js` — three modes (type / camera / upload), photo-match display, new flag descriptions
- `index.html`, `retailer.html`, `admin.html` — favicons, image logos, upload UI
- `styles.css` — new styles for upload cards, image logos, match indicators
- `package.json` — unchanged

### Logo assets (used by all pages)
- `favicon.png` — 192×192 square crop of the shield, used as favicon and topbar mark
- `favicon-32.png` — 32×32 favicon variant
- `logo-shield.png` — original shield logo (your upload)
- `logo-horizontal.png` — horizontal logo on black background (your upload)
- `logo-horizontal-transparent.png` — same logo with the black background made transparent

### Landing page (host separately)
- `landing.html` — single self-contained file, no server needed

---

## How to deploy

### Step 1 — push the app changes

```bash
cd C:\Users\gajan\Downloads\files

# Copy all files from this folder into your project (overwriting)
# Then push:
git add .
git commit -m "Add ID upload, face matching, bigger barcode, logo, drop Trulioo"
git push
```

Render will auto-redeploy in 2-3 minutes.

### Step 2 — host the marketing page

The marketing page is **separate** from your app. Cheapest options:

| Option | Cost | Setup time |
|--------|------|------------|
| **GitHub Pages** | $0 | 5 min — push `landing.html` + `favicon.png` to a new repo, enable Pages |
| **Netlify Drop** | $0 | 30 sec — drag the folder onto netlify.com/drop |
| **Cloudflare Pages** | $0 | 5 min — connect GitHub repo |
| Buy domain (e.g. mapleproof.ca) and point it at any of the above | ~$15/yr | 30 min |

**Recommended:** Netlify Drop for fastest test. Just go to https://app.netlify.com/drop, drag `landing.html` + `favicon.png` + `favicon-32.png` + `logo-shield.png` into the page, and you'll get a live URL instantly.

### Step 3 — (optional) run locally

```bash
node server.js
# Visit http://localhost:3000
```

For the camera to work locally on Windows, generate an SSL cert first (or just use upload mode, which works on plain HTTP).

---

## How face matching works (so you know what you're shipping)

1. User uploads front of ID + back of ID
2. App reads the PDF417 barcode from the back image and parses it (name, DOB, etc.)
3. User takes selfie
4. **Before submitting:** the browser loads `face-api.js` models (~6MB, cached after first load) and runs both images through:
   - Face detection (TinyFaceDetector)
   - 68-point face landmarks
   - Face descriptor extraction (128-D vector)
5. Computes euclidean distance between the two descriptors → similarity score in 0–1
6. Sends score with registration. Server stores it.
7. When retailer scans the pass, server returns the score:
   - **≥ 0.55** = strong match (green ✓)
   - **0.40–0.55** = weak match (orange, requires cashier review)
   - **< 0.40** = fail (red, sale should be refused)

**Important:** This runs entirely in the customer's browser. No images are sent to a third-party API. The selfie + ID photos are encrypted and stored only in your own database.

---

## Known limitations

- **Render free tier sleeps** after 15 min of inactivity. First request after sleeping takes ~30 sec.
- **Render free tier loses data on redeploy** (~monthly). For persistence add a $7/mo disk.
- **face-api.js models load from a public CDN** — if that CDN is down, face matching is silently skipped (the rest still works).
- **Face matching needs a clear face** in both the selfie and the ID front. If either is blurry/dark, the match is "Skipped" rather than failing.
- **No bank-grade liveness detection** — face-api.js can be fooled by a photo of a face. If you need anti-spoofing later, AWS Rekognition Face Liveness is $0.015/check (~50% cheaper than Stripe Identity).
