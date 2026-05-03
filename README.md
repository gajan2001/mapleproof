# Mapleproof — v7 (twin photos, full 360 head sequence, real match scores)

Three real fixes from your last bug report:

## Fix 1: ID face is NOW shown on the pass card 🎯

**The bug:** v6 cropped the ID face but didn't actually display it on the pass — only the live face appeared next to the barcode.

**The fix:** Pass card now shows **two side-by-side photos** above the barcode:
- **LIVE PHOTO** (left) — your face from the liveness check
- **ID PHOTO** (right) — face cropped from the front of your ID

A subtle vertical divider sits between them. Below the barcode, a 3-column meta row shows: **Status · Photo Match · Issued**.

The downloadable PNG of the pass also has both photos drawn side by side.

The retailer also now receives the ID face when they scan, so they can visually compare LIVE vs ID at the counter.

## Fix 2: Match scores are now realistic (not stuck below 60%)

**The bug:** v6 used `similarity = 1 - distance`. With face-api.js, normal "same person" matches return distance 0.4-0.6 → similarity 40-60%. So even legitimate matches always looked weak.

**The fix:** Non-linear similarity mapping that reflects how face-api.js actually behaves:

| face-api distance | What it means | Display % |
|---|---|---|
| < 0.30 | very strong match | **90-100%** |
| 0.30 - 0.40 | strong match | **80-90%** |
| 0.40 - 0.50 | normal same-person match | **70-80%** |
| 0.50 - 0.60 | weak / borderline | **50-70%** |
| 0.60 - 0.80 | likely different person | **10-50%** |
| > 0.80 | clearly different | **<10%** |

Server thresholds bumped: ≥70% = strong (green ✓), 55-70% = weak (review), <55% = fail (red ✗). Matches that used to score 50% now correctly score 70-80%.

## Fix 3: Liveness is now a full 4-direction sequence

**Before:** 2 random challenges out of {left, right, up, down}. Felt incomplete.

**Now:** All 4 directions (left, right, up, down) every time, in a randomized order so it can't be replayed from a recorded video. Plus the front-facing capture step at the end. Total flow:

1. **Calibrating…** (1.5 sec) — silently captures backup front-facing frame
2. **Step 1 of 4** — random direction, e.g. 👆 Tilt UP
3. **Step 2 of 4** — random direction
4. **Step 3 of 4** — random direction
5. **Step 4 of 4** — random direction
6. **Final step** 📸 Look straight at the camera (~3 sec) → captures the photo used for the pass + ID match

Each direction times out after 18 sec. Manual fallback button "Having trouble? Tap when done →" still appears after 6 sec for accessibility.

## Files changed in v7

| File | Change |
|---|---|
| `liveness.js` | Non-linear similarity mapping; full 4-direction shuffle |
| `app.js` | `state.idCroppedFace` field; pass card sets both photos; sends `idFaceImage` to server; download canvas draws both photos; new match-score thresholds |
| `app.html` | New `pass-twin-photos` div with LIVE + ID photo cards; updated intro copy to "4-direction" |
| `styles.css` | Styles for `pass-twin-photos`, `pass-photo-card`, `pass-photo-divider`, `pass-meta-grid.full` |
| `server.js` | New `id_face_enc` column with auto-migration; accepts/stores/returns `idFaceImage`; new strong/weak thresholds |

Everything else is unchanged from v6 (logos, head-movement-only liveness, manual fallback, etc.)

## Deploy — 5 files

```bash
cd C:\Users\gajan\Downloads\files
git add liveness.js app.js app.html styles.css server.js
git commit -m "Twin photos on pass + 4-direction liveness + realistic match scores"
git push
```

Render redeploys in 2-3 min. Watch the logs for `[mapleproof] migrated: id_face_enc` confirming the new column was added to your existing database.

## What you'll see

1. **Liveness intro** says "4-direction head movement check"
2. After calibration, you'll do all 4 directions: left → right → up → down (random order). Each one shows the orange face box turning green when registered.
3. **Final 📸 step** — look straight at the camera for 3 sec
4. Pass card displays **TWO photos above the barcode**:
   ```
   ┌─────────┬─────────┐
   │  LIVE   │   ID    │
   │ [face]  │ [face]  │
   └─────────┴─────────┘
   [────── BARCODE ──────]
   Status · Photo Match · Issued
   ```
5. **Photo Match** value typically shows 70-90% for actual matches now — this is what users expect to see, and it gives retailers a meaningful signal at the counter.

## Caveats (unchanged)

- Models still load from `justadudewhohacks.github.io` CDN
- The 4-direction sequence is more thorough but takes ~30-40 seconds total. If users complain about length, you can reduce `challengeCount: 4` → `3` in app.js.
- Not bulletproof against deepfakes — that requires AWS Rekognition Face Liveness ($0.015/check)
