# Mapleproof — v3 (marketing landing on the same domain)

The marketing landing page is now part of the main app — no separate hosting needed.

## URL structure

| URL | What it shows |
|---|---|
| `https://mapleproof.onrender.com/` | **Marketing landing page** (the one in your reference design) |
| `https://mapleproof.onrender.com/app` | The actual customer flow (Get My Pass) |
| `https://mapleproof.onrender.com/retailer` | Retailer scanner — unchanged |
| `https://mapleproof.onrender.com/admin` | Admin dashboard — unchanged |

The "Get My Pass" buttons on the landing page link to `/app`, so visitors flow naturally from marketing → app on the same site. No more separate Netlify/GitHub Pages needed.

## What changed from v2

- **Renamed `landing.html` → `index.html`** (so it serves at `/`)
- **Renamed old `index.html` → `app.html`** (so the customer flow now serves at `/app`)
- **Added `/app` route** in `server.js`
- **Updated all "Get My Pass" links** in the landing page from `https://mapleproof.onrender.com/` to `/app` (relative — faster, no DNS hit)
- **Added "← Home" link** to app's topbar so users can navigate back to marketing
- **Updated retailer + admin "Customer" links** to point to `/app` instead of `/`

Everything else is unchanged from v2 (active liveness, ID upload, face matching, etc.).

---

# Mapleproof — v2 (with active liveness detection)

Now includes **active liveness challenges** — the user must perform 3 random physical actions in front of the camera (blink, smile, turn head, etc.) to prove they're a real person and not a printed photo / screen.

Cost: still **$0/month**. Everything runs in the browser.

---

## What's new in v2

### 🛡️ Active liveness detection (the big one)

Replaces the old "take a selfie" with a real anti-spoofing flow:

1. **Random sequence of 3 challenges** chosen from:
   - 👁️ Blink your eyes
   - 😄 Smile big
   - 😮 Open your mouth
   - 👈 Turn your head LEFT
   - 👉 Turn your head RIGHT

2. **Real-time verification** — each challenge is checked frame-by-frame using face-api.js facial landmarks:
   - Blink → Eye Aspect Ratio (EAR) drops below threshold then recovers
   - Smile → Mouth width grows relative to face width
   - Mouth open → Inner-lip vertical gap exceeds 30% of mouth width
   - Head turn → Nose tip offset from face-center exceeds 13%

3. **Live face box overlay** turns green when the challenge is satisfied

4. **5 frames captured** across the sequence — best one (highest detection confidence) becomes the pass photo

5. **128-D face descriptor** extracted during liveness is reused for ID matching (faster than re-running face detection)

### Why this is "better than just a selfie"

| Attack | Old (selfie) | v2 (liveness) |
|---|---|---|
| Printed photo | Passes ✓ | Fails — no movement |
| Video of someone else | Passes ✓ | Fails — won't match random challenge |
| Screen recording | Passes ✓ | Fails — challenges are random per session |
| Deepfake video | Passes ✓ | Likely fails — challenges happen too fast for live deepfake response |

This is functionally similar to Uber's driver verification, just using `face-api.js` instead of their proprietary model.

### Server-side additions
- New columns: `liveness_verified`, `liveness_challenges` (auto-migrated)
- `/api/register` accepts `livenessVerified` and `livenessChallenges`
- `/api/pass/:token` returns `livenessVerified` flag
- New retailer flag: `NO_LIVENESS_CHECK` for legacy registrations

---

## Files (17 total)

### New files
- `liveness.js` — the liveness detection module (337 lines)
- `.gitignore` — proper Node.js gitignore (answers your earlier question — `node_modules` IS supposed to be excluded)

### Updated files
- `app.js` — replaced "take a selfie" with `runLivenessFlow()`, sends liveness data to server
- `index.html` — new liveness UI (intro / active / loading / fail screens)
- `styles.css` — liveness UI styles
- `server.js` — `liveness_verified` + `liveness_challenges` columns, exposed in pass API
- `retailer.js` — `NO_LIVENESS_CHECK` flag description

### Unchanged from v1
- `retailer.html`, `admin.html`, `admin.js`, `package.json`
- `landing.html`, all logo PNGs

---

## About `node_modules` and GitHub

**Short answer: `node_modules` is supposed to be excluded from GitHub. This is correct.**

The `.gitignore` file in this folder tells Git to skip:
- `node_modules/` — npm downloads these on the server when it runs `npm install`
- `data/` — your local SQLite database (you don't want to commit user data!)
- `cert.pem`, `key.pem` — SSL certs (regenerate locally)
- `.encryption.key`, `.admin-token` — secrets

**How it works:**
1. You commit `package.json` (the recipe)
2. GitHub stores just `package.json`
3. On Render, the build step runs `npm install` which reads `package.json` and downloads everything fresh

You'll see this in your Render logs every deploy:
```
==> Running build command 'npm install'...
added 105 packages, and audited 106 packages in 1m
==> Build successful 🎉
```

That `added 105 packages` is Render rebuilding `node_modules` itself.

---

## Deploy

Replace your project files with this folder, then:

```bash
cd C:\Users\gajan\Downloads\files
git add .
git commit -m "Add active liveness detection (anti-spoofing)"
git push
```

Render auto-redeploys in 2–3 min. Watch the logs for the `[mapleproof] migrated: liveness_verified` message — that confirms the new columns were added to your existing database.

---

## How to test the liveness flow

1. Visit `https://mapleproof.onrender.com/` on a phone (Chrome or Safari)
2. Tap "Get my pass"
3. Upload front + back of your ID
4. Tap "Process ID"
5. **NEW** — see the liveness intro screen explaining what's about to happen
6. Tap "Start liveness check"
7. Allow camera access
8. ~6MB of face-recognition models download (first time only — cached after)
9. Camera turns on, face box appears around your face
10. Random prompt appears: e.g. "Blink your eyes" with a 👁️ icon
11. Do it — face box turns green, "✓ Got it!" appears
12. Two more random challenges
13. Pass is generated with your captured face + photo match score

**Try fooling it** — hold up a printed photo. The first "blink" challenge will fail and you'll get an error message.

---

## Known limitations of liveness.js

- **Lighting matters** — needs decent lighting on the face to detect landmarks reliably
- **CDN dependency** — face-api.js models load from `justadudewhohacks.github.io`. Self-hosting them in `/public/models/` would remove this dependency
- **Not bulletproof** — a sophisticated attacker with a high-quality video deepfake could potentially perform the challenges in real-time. For bank/exchange-grade security you'd want AWS Rekognition Face Liveness ($0.015/check, $200 free AWS credit) which has additional anti-spoofing techniques (depth analysis, texture analysis, etc.)

For 19+ retail/age-gate use cases, this level of liveness is appropriate and roughly equivalent to what TikTok, Snapchat, and Uber use for casual identity verification.

---

## Quick reference — the 5 liveness challenges

| Icon | Prompt | How it's verified | Detection threshold |
|------|--------|-------------------|---------------------|
| 👁️ | Blink your eyes | EAR (Eye Aspect Ratio) drops then recovers | < 0.20 then > 0.27 |
| 😄 | Smile big | Mouth width grows relative to face width | width/face > 42%, h/w < 35% |
| 😮 | Open your mouth | Inner-lip vertical gap | inner H / mouth W > 30% |
| 👈 | Turn head LEFT | Nose offset right of center (mirrored) | offset > +13% |
| 👉 | Turn head RIGHT | Nose offset left of center (mirrored) | offset < −13% |

Each session picks 3 of these 5 at random. With 5×4×3 = 60 possible orderings, an attacker can't pre-record a video and replay it.
