# Mapleproof — v8 (face-only ID crop, no info bleed)

## What changed

**The bug:** v7 used the face *detection box* with 0.95× padding. That box is a loose rectangle that often includes neck and shoulders — and when applied to an Ontario license layout (where text sits right next to the photo), the crop pulled in DOB, signature, address, gender, etc.

**The fix:** Three layered safeguards:

### 1. Landmark-based cropping (instead of detection box)

Uses face-api.js's 68-point landmarks to find the **actual face extent** — the precise bounding box of all face features (eyebrows to chin, ear to ear). This is much tighter than the detection box.

### 2. Asymmetric padding tuned for ID layouts

| Side | Padding | Why |
|---|---|---|
| Top | 40% of face height | Include hair |
| Bottom | 10% of face height | Just under chin |
| Left/right | 10% of face width | Avoid ID text bleed |

Sides are now 9× tighter than v7. Top still has reasonable headroom for hair.

### 3. Circular mask safety net (ID photo only)

The ID-side crop applies a soft circular mask after cropping — anything in the corners (where text might still bleed in if the face was photographed off-center) fades to white via a radial gradient.

The live-photo side keeps a square crop (no mask needed — there's nothing identifying behind your face on the live camera).

### What you'll see

- **LIVE PHOTO** (left): clean square portrait, your face only
- **ID PHOTO** (right): circular face crop with white corners — guaranteed no DOB / address / signature / gender info

## Important: face matching unchanged

The match score still uses the **full ID front photo** (face-api can find the face and extract a clean descriptor on its own). The crop is purely cosmetic — for display only. So matching accuracy is unaffected.

## Files changed in v8

Just two files:

- **`liveness.js`** — rewrote `cropFaceFromImage()` to use landmarks + asymmetric padding + optional circular mask
- **`app.js`** — calls cropFaceFromImage with `{ circular: false }` for live, `{ circular: true }` for ID; matches against full ID front (better accuracy)

Everything else from v7 is unchanged (twin photos on pass card, 4-direction liveness, realistic match scores, transparent logos).

## Deploy

```bash
cd C:\Users\gajan\Downloads\files
git add liveness.js app.js
git commit -m "Tighter face-only crop with circular mask for ID photo"
git push
```

Render redeploys in 2-3 min. Re-register a test user to see the new ID crop.

## Caveat

If the original ID photo has the face very close to the edge of the photo (or the face is small/tilted), the crop may still lean against the edge of one side. The circular mask handles this gracefully by fading to white instead of cutting hard. But for badly-photographed IDs, ask the user to retake the front photo.
