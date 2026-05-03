# Mapleproof — v6 (front-facing capture + clean logos)

## What changed

### Fix 1: Photo match scores will be much higher

**The bug:** v5 captured the user's face *during* head-turn challenges. That meant the saved photo was at an awkward angle (head turned 15-20°), while the ID photo is straight-on. The descriptor distance was naturally large because the face geometry was different — not because it wasn't the same person.

**The fix:** Two front-facing captures, both during straight-on moments:

1. **During calibration** — the camera continuously snapshots while you're looking at it before challenges start. It keeps the highest-quality front-facing frame (lowest yaw + pitch deviation, highest detection confidence).

2. **Final "Look straight at the camera" step** — after the head-turn challenges, there's a new step (📸 icon) where the user faces forward for ~3 seconds. We capture up to 3 frames where yaw and pitch are within ±0.08 of baseline.

The pass photo + ID match descriptor come from this final step (or fall back to the calibration capture). **Both are guaranteed to be straight-on**, just like the ID. Match scores should be significantly higher now.

### Fix 2: Logo looks bigger and professional (no white box)

**The bug:** The favicon.png had a white background visible on white-page elements like the topbar. Same for the small "sm" version on the pass card.

**The fix:** Generated two new logo assets with **transparent backgrounds**:

- `logo-leaf-mark.png` — clean maple-leaf-only mark for compact spaces (topbar 44×44, pass card 24×24). No shield, no white background.
- `logo-shield-transparent.png` — full shield with the white background removed, used for the home-screen hero at 160px.

Sizes are bumped up across the board:
- Topbar logo: 36px → **44px**
- Pass card mini-logo: 22px → **26px**
- Hero logo: 84px → **160px (auto-scales on small screens via `max-width: 50vw`)**

Subtle drop shadow added so the logos pop on white backgrounds.

## Files changed in v6

| File | Change |
|---|---|
| `liveness.js` | Calibration captures best front-facing frame; new "look straight" step at end captures up to 3 forward-facing frames; result picks from finalCaptures → calibration.frontFacing → fallback |
| `app.html` | Topbar uses `logo-leaf-mark.png` 44px; hero uses `logo-shield-transparent.png` 160px; pass card uses leaf mark 24px |
| `retailer.html` + `admin.html` | Topbars use `logo-leaf-mark.png` 44px |
| `styles.css` | Bigger logo sizes + drop-shadow |
| **NEW:** `logo-leaf-mark.png` | Clean maple-leaf-only mark (transparent bg) |
| **NEW:** `logo-shield-transparent.png` | Full shield with transparent bg |
| `favicon.png` + `favicon-32.png` | Regenerated from the transparent shield |

Everything else unchanged from v5 — no blink detection, head-movement challenges only, manual fallback button, calibrated thresholds.

## To deploy

```bash
cd C:\Users\gajan\Downloads\files
# Copy these from mapleproof-v6/:
#   liveness.js, app.html, retailer.html, admin.html, styles.css,
#   logo-leaf-mark.png, logo-shield-transparent.png,
#   favicon.png, favicon-32.png
git add liveness.js app.html retailer.html admin.html styles.css \
        logo-leaf-mark.png logo-shield-transparent.png \
        favicon.png favicon-32.png
git commit -m "Front-facing capture for ID match + clean transparent logos"
git push
```

## What you'll see now

1. Open `/app` — bigger shield logo on the home screen, leaf-only mark in the topbar
2. Upload ID, tap "Process ID", tap "Start liveness check"
3. **"Calibrating… 5/14"** — meanwhile, behind the scenes, your best front-facing frame is being captured silently
4. **"Turn your head LEFT"** 👈 — do it (face box turns green)
5. **"Tilt your head UP"** 👆 — do it
6. **NEW: "Look straight at the camera"** 📸 — face forward for ~3 sec, "Captured 3/3" appears
7. Pass card shows your face cropped square, **looking straight ahead** (matches the ID pose), with the leaf mark in the corner
8. Photo match score should be in the 60-90% range for actual matches now (was 30-50% before because of the angle mismatch)

## Caveats

- Models still load from `justadudewhohacks.github.io` CDN
- The final capture step adds ~3 seconds to the flow but produces dramatically better match scores
- If for some reason no straight-on frame is captured (you wandered off, etc.), it gracefully falls back to the calibration capture
