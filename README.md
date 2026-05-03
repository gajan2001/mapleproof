# Mapleproof — v4 (fixed liveness, face-only pass photo)

Three real fixes from your last bug report:

## 🩹 Fix 1: Blink check no longer fails for everyone

**Root cause:** The old version used a fixed Eye Aspect Ratio threshold (0.20 / 0.27). That happens to match the *average* EAR for adult eyes — but it doesn't work for:
- People with naturally narrow eyes (resting EAR < 0.25 — they could fully close their eyes and never trigger it)
- People with wide eyes (resting EAR > 0.30 — they "blink" but never recover above 0.27)
- Variations from camera angle, glasses, lighting

**The fix:** Calibration step. Before the challenges start, the camera reads your face for ~1.5 seconds to learn *your* resting EAR. The blink threshold is now **70% of your personal baseline** to count as closed, **88%** to count as recovered. Same idea for smile detection (uses your resting mouth width).

Other improvements:
- Polling is now 30ms (was 80ms) so quick blinks aren't missed
- **Live hint text** below the prompt — "Eyes look open — try a deliberate blink" / "Almost — keep smiling" — so the user knows the camera is actually seeing them
- Face box turns green when the challenge is satisfied (for instant feedback)
- Timeout per challenge raised from 12s → 15s

## 🎯 Fix 2: Face matching uses cropped faces (more accurate)

**Before:** The match compared the live frame (with hair, hands, background) against the full ID image (with text, holograms, background). Backgrounds added noise that lowered match scores.

**Now:**
1. Liveness check runs and gets a face descriptor
2. App crops just the face out of the ID front photo
3. Match runs against the **cropped** ID face — no background interference
4. Score is more reliable and almost always higher when faces actually match

## ✂️ Fix 3: Pass photo is now a clean face crop

**Before:** The pass card showed the full live frame (which included background + arms + room).

**Now:** The pass card photo is a **square crop centered on your face**, ~85% padded so it includes hair and chin but no room background. No ID text is ever displayed on the pass — the face crop is pulled from the live capture, not the ID.

The download/save-as-PNG version of the pass also uses this same cropped face.

---

## What ships in this folder

### Modified
- **`liveness.js`** — completely rewritten with calibration, relative thresholds, faster polling, hint feedback, plus a new `cropFaceFromImage()` helper
- **`app.js`** — calls `cropFaceFromImage()` for both live capture AND ID front, uses cropped images for matching, updates state to use cropped face for the pass display + download
- **`app.html`** — added `<div id="liveness-hint">` for the live feedback line
- **`styles.css`** — added `.liveness-hint` style

### Unchanged from v3
- `index.html` (marketing landing at `/`)
- `app.html` (customer flow at `/app`)
- `retailer.html`, `retailer.js`, `admin.html`, `admin.js`
- `server.js`, `package.json`, `.gitignore`
- All logo/favicon PNGs

---

## URL structure (still v3)

| URL | Page |
|---|---|
| `/` | Marketing landing |
| `/app` | Customer Get-My-Pass flow |
| `/retailer` | Retailer scanner |
| `/admin` | Admin dashboard |

---

## To deploy

```bash
cd C:\Users\gajan\Downloads\files
# Copy the 4 changed files: liveness.js, app.js, app.html, styles.css
git add liveness.js app.js app.html styles.css
git commit -m "Fix liveness blink detection + cropped face on pass"
git push
```

Render auto-redeploys in 2-3 min.

---

## How to test

1. Open `https://mapleproof.onrender.com/app` on a phone in good lighting
2. Upload front + back of your ID
3. Tap "Process ID" → "Start liveness check"
4. **Notice:** You'll see "Calibrating… 5/15" first (this is new — it's reading your resting face)
5. First challenge appears with a hint line below it
6. **Try blinking once.** It should detect it now even with narrow eyes / glasses / dim lighting.
7. After 3 challenges, pass card shows your face cropped from the live capture (just face, no background)
8. Photo match score should be higher than before (since both sides are cropped)

If a challenge still fails:
- Check the hint line — it tells you what the camera is seeing
- Make sure your face is well-lit and centered (the orange face box should follow you)
- Try the action more deliberately (full eye close, big smile, clear head turn)

---

## Honest caveats (unchanged from v3)

- Models load from `justadudewhohacks.github.io` — first-run takes ~6MB download
- Not browser-tested by me — all syntax checks pass and feature wiring verified, but couldn't `npm install` in my sandbox to start a real server
- Not bulletproof against deepfakes — for bank-grade liveness, AWS Rekognition Face Liveness is $0.015/check
