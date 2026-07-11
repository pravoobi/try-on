# Plan: AI-powered 3D-ish garment assets (depth-augmented try-on, user-uploaded garments)

**Status:** Phases A1 (`c8b7adc`), A2 (`7396edc`), A3 (`afee4a1`, which also
reworked A2's occlusion reference — see the A2 notes below, updated to
match), A4 (user garment upload), and A5 (orientation-aware warp, view
selection, live-mode depth throttling) are done — this completes the Tier A
build. This document is written for an implementing agent/model with access
to this repo; it assumes CLAUDE.md has been read. Verify library APIs at
build time — the browser-ML ecosystem moves fast.

**Phase A1 implementation notes (for whoever builds A2+):**
- `useAdvancedMode` (src/hooks/useAdvancedMode.ts) is the gate — `enabled`
  persisted to localStorage, owns the depth.worker.ts lifecycle, exposes
  `estimateDepth(bitmap): Promise<ImageBitmap>`. A2/A3 should extend this
  hook (or add sibling hooks) rather than duplicating its worker-lifecycle
  pattern.
- `depth.worker.ts` uses `@huggingface/transformers`'
  `onnx-community/depth-anything-v2-small`, `device: 'webgpu'|'wasm'`
  (feature-detected via `'gpu' in navigator`), `dtype: 'fp16'` on webgpu
  / library default (q8) on wasm. Wasm inference on this model is slow
  (~30s observed for a single portrait-sized photo) — A5's live-mode
  throttling is load-bearing, not optional, and even A2/A3's photo-mode
  work should keep this in mind for UX (show a "computing…" state).
  `progress_callback` events give `{loaded, total}` per file but not a
  file identifier usable for a precise multi-file progress bar; the
  current aggregate-across-events approach is an approximation, good
  enough for a progress percentage but worth revisiting if it looks wrong
  for a multi-file model.
- The depth debug view (DebugCanvas `depthBitmap` prop) is a full-canvas
  replacement, not a tint — A2's per-pixel occlusion and A3's relighting
  will need their own compositor-level access to the depth map (via
  `useAdvancedMode.estimateDepth`), not this debug overlay path.

**Phase A2 implementation notes (updated after Phase A3's occlusion rework):**
- `applyDepthOcclusion` (pipeline/compositor.ts) is the depth-tested
  occlusion path; `drawArmOcclusion` is now purely the simple-mode/no-depth
  fallback. Both are chosen inside `renderTryOn`/`renderLehengaCholiTryOn`
  based on whether `input.personDepth` was passed in.
- The reference "garment surface depth" must come from real on-body
  locations, never the garment anchor targets (`bodyAnchors`/
  `GarmentAnchors`) — Phase A1 deliberately widens those past the body's
  own silhouette edge (`config.anchors.widthScale`, up to 1.45x at the
  hips) so fabric fully covers the mask-clipped region, and sampling depth
  there can land in the background.
- **Second load-bearing gotcha (found during A3 verification, don't
  reintroduce): the reference must also be statistically robust, not a
  smooth fit through a handful of sparse points.** The original A2 design
  built a TPS surface through just the 4 raw keypoints (shoulders/hips).
  TPS is a *global* interpolant — a single anomalous sample (e.g. a
  shoulder keypoint landing exactly on a strap or shadow edge, a real
  local depth feature, not noise) drags the *entire* smooth surface down
  across a wide area, with no error or exception. Confirmed with a real
  photo: one shoulder sample sat ~40 gray levels below the other three,
  which was enough to falsely mark a large fraction of the torso as
  "person in front" and reveal the person's actual (printed) shirt through
  the garment. Separately, monocular depth estimation also genuinely
  misjudges high-contrast prints/patterns as height variation, compounding
  the problem. The fix (now in place): sample a dense grid across the
  torso interior (bilinear between the 4 keypoints, ~16 points) and take
  the *median* as a single constant reference, plus a box blur
  (`config.depthOcclusion.blurRadiusPx`) on the comparison depth field to
  suppress the print-driven high-frequency noise a real arm-in-front
  discontinuity doesn't have. If you touch this function, keep both: blur
  alone doesn't fix a single-sample outlier, and a robust reference alone
  doesn't fix per-pixel print noise.
- Trade-off worth knowing: the reference is now a single constant across
  the whole torso bbox, not a spatially-varying field — simpler and far
  more robust, but it won't follow a genuine front-to-back lean (e.g. hips
  measurably closer to camera than shoulders). Untested against strongly
  leaning poses; revisit if that turns out to matter.
- The occlusion scan is bounded to an expanded torso bbox
  (`config.depthOcclusion.bboxMarginFrac`), not the full frame — fine at
  photo-mode resolutions/latencies, but if A5's live-mode throttling ends
  up calling this per-frame, re-profile; the box blur is O(w×h) (separable,
  not O(w×h×radius²)) but still real work at 15fps.

**Phase A3 implementation notes (for A4/A5):**
- New modules: `pipeline/normalMap.ts` (`depthToNormalMap`, pure
  synchronous Sobel-style math, no model inference) and `pipeline/
  relight.ts` (`estimateLight`, `applyGarmentShading`).
- Normal maps are computed once per garment selection in App.tsx, alongside
  the existing garment depth (reuses the SAME depth result — no extra
  `estimateDepth` call). For a lehenga-choli, each piece needs its own
  normal map since they're separate photos; see the `GarmentNormals` type
  and the effect that produces it.
- `estimateLight` is cheap enough (bounded to a 128px-max working canvas)
  to call fresh on every render inside the compositor — unlike depth, it
  needs no React-side caching/state.
- The "shading" checkbox is the A/B toggle the plan's done-when asks for.
  It's implemented by omitting the normal map(s) from `GarmentOverlay` when
  unchecked (see App.tsx's `garmentOverlay` memo), not by adding a boolean
  flag through the compositor — mirrors how `personDepth` already gates
  A2's occlusion.
- Emergent behavior worth knowing about, not a bug: depth-estimating a
  garment with a bold print or the skirt's stripe pattern produces a
  normal map with fake "relief" following that pattern (the depth model
  reads high-contrast print edges as height variation, same failure mode
  noted in the A2 gotcha above). The shaded result then shows the print's
  shape as a subtle emboss/fold-line effect. This looks good for the
  current placeholder/real assets tested and is arguably a desirable side
  effect, but it isn't real fabric geometry — don't be surprised by it,
  and don't rely on it being *consistent* across different garment photos.

**Phase A4 implementation notes (for A5):**
- Matting is a *second*, independently-lazy model gate from A1's depth
  infrastructure — `useMatting` (src/hooks/useMatting.ts) creates
  `matting.worker.ts` (`@huggingface/transformers`'
  `'background-removal'` task, default model `Xenova/modnet`) only when the
  upload panel is actually opened, and tears it down (`enabled=false`) the
  moment the panel closes. Unlike `useAdvancedMode`, this isn't a standing
  user preference — no localStorage persistence — since most sessions will
  open the upload flow at most once.
- `'background-removal'`'s pipeline output already has real alpha
  transparency applied (`RawImage.putAlpha` internally) — no separate
  mask-then-composite step needed on our side, just `.toCanvas()` →
  `createImageBitmap()` straight to the main thread.
- `pipeline/autoAnchor.ts` is pure-function + canvas-touching but
  React-free, per the pipeline/ convention: `findAlphaBBox`/`rowExtents`
  operate on a raw `Uint8ClampedArray` (unit-tested in isolation);
  `cropToAlphaBBox` and `suggestAnchors` are the two callers that touch
  `OffscreenCanvas`/`ImageBitmap`. Shoulders = widest row in the top band;
  hem = bottom-band average (robust to a stray pixel); waist = narrowest
  row between them, falling back to a straight shoulder→hem interpolation
  when the garment has no real taper (a boxy tee) rather than trusting a
  noisy "narrowest pixel" on a straight-cut silhouette.
- **L/R convention gotcha:** auto-suggested anchors use image-left/right
  (smaller x = `...L`), matching the existing hand-annotated
  `catalog.json` convention — *not* the anatomical "wearer's own left"
  convention `tools/annotate.html`'s comments describe (that's about body
  keypoints, a different coordinate space). Verified against real catalog
  data before writing the auto-suggest logic; getting this backwards would
  silently mirror every auto-suggested anchor set relative to hand-annotated
  ones.
- User uploads are unified with catalog garments through the exact same
  `Garment`/`GarmentPicker`/`fetchBitmap` code paths with zero
  special-casing, via two small tricks: `assetUrl()` passes any absolute
  URL through unchanged (a regex check), and uploaded images are persisted
  in IndexedDB as Blobs (`garments/userGarmentStore.ts`) then exposed as
  `blob:` object URLs at load time (`hooks/useUserGarments.ts`). Both URL
  schemes flow through identical `fetch()`/`<img src>` calls downstream —
  `GarmentPicker.tsx` required no changes for A4.
- Verified end-to-end in Chrome with synthetic "phone photo of a shirt on a
  bed" test images (opaque noisy background + solid silhouette, generated
  in-page via canvas since no real phone photo was available): front-only
  upload (skip back) and front+back upload both complete in well under 60s
  from file-select to picker auto-select, including the ~500KB model
  download on first use (instant on repeat opens — the browser HTTP cache
  covers the model weights). Anchor auto-suggestion landed correctly on the
  synthetic silhouette without manual adjustment; drag-adjust, category/
  sleeve/length selects, IndexedDB persistence across a full page reload,
  and try-on compositing (identical code path to catalog garments) all
  confirmed working with no console errors.

**Phase A5 implementation notes:**
- **Yaw heuristic is 2D-only, as the plan sanctioned as an interim** — the
  app still runs MoveNet (no z), not BlazePose, so `pipeline/orientation.ts`
  estimates only |yaw| (magnitude, 0-180°, no signed left/right) from two
  signals: shoulder width relative to a running "most-frontal-observed"
  calibration (`updateOrientationCalibration`, grows instantly on a wider
  confidently-frontal frame, else decays slowly — `config.orientation.
  calibrationDecay` — so a stale high-water-mark relaxes rather than
  permanently reading normal frames as "turned"), disambiguated near 180°
  by nose/eye keypoint confidence dropping out (the 2D stand-in for the
  plan's "landmark z-order flips ... visibility scores drop" signal). BlazePose
  was NOT adopted — swapping the pose model was evaluated as too much risk/
  churn for this pass; MoveNet + the width heuristic meets the phase's
  done-when criteria. Revisit BlazePose if the heuristic proves too noisy
  in practice.
- **Orientation is live-mode only, by design, not merely by convenience:** a
  single photo has no prior frame to calibrate a "frontal" baseline
  against, so `hooks/useTorsoOrientation.ts` only produces a non-null
  result while its `active` flag is true, and resets calibration on every
  false→true transition (fresh session, no stale baseline from a previous
  photo/person/distance). Photo mode is therefore provably unaffected:
  `foreshortenFactor` defaults to 1 and `viewAlpha` to 1 whenever
  orientation is null — verified both by the zero-diff behavior in
  `selectGarmentView(null, ...)` (unit tested) and by a live Chrome check
  (identical render before/after, no console errors).
- **View selection doesn't key off the discrete `zone` label** — an early
  version gated the back-view crossfade on `zone === 'back'`, which only
  ever produces `alpha === 1` immediately since the zone boundary and the
  ramp's own endpoint coincide (caught by a unit test). Fixed by having
  `selectGarmentView` compute its own yaw-threshold logic directly: the
  back view starts crossfading in `fadeRampDeg` degrees *before* the
  nominal `backMinYawDeg` threshold, reaching full opacity exactly at it —
  a continuous front-fades-out-then-back-fades-in handoff through the
  profile band, never a hard pop. `TorsoOrientation.zone` remains a useful
  coarse label for the live debug readout, just isn't consulted by
  rendering decisions.
- **Foreshortening is a 2D horizontal squeeze, not the plan's depth-weighted
  asymmetric version** — `anchorMapping.foreshortenAnchors(anchors, factor)`
  compresses all anchor x-coordinates toward the set's own centroid by
  `factor = pipeline/orientation.ts's foreshortenFactor(yawDeg, floor)`
  (1 at front/back, floor at deep profile, symmetric around 90°); y is
  untouched. The plan's §5.4.3 "weight by depth map so the near side scales
  up" asymmetric refinement was deliberately skipped — the phase's
  done-when only asks for *plausible* foreshortening, and this is applied
  uniformly to `bodyAnchors` (renderTryOn) and both `choliBody`/`skirtBody`
  (renderLehengaCholiTryOn) before the existing TPS solve, so it's a small,
  contained addition rather than a warp-pipeline rewrite. Revisit if a
  strongly-leaning/asymmetric pose ever needs it.
- **Back-view anchor mirroring is a fixed rule, not dynamic detection** —
  `anchorMapping.mirrorAnchorsLR` swaps L/R-named anchors unconditionally
  whenever a garment's `back` piece is rendered (see App.tsx's
  `garmentOverlay` memo), per the plan's own instruction ("the person's
  left shoulder anchors the back image's right-side anchor"). This does
  NOT depend on whatever the pose model's L/R keypoint labeling is doing
  at that moment (which the plan itself notes gets unreliable near 180°) —
  it's a static convention applied only when swapping which *image* to
  render, keeping `computeBodyAnchors` itself completely unaware of
  front/back.
- **`compositor.ts` stays agnostic to "front vs back" and to the `Garment`
  schema entirely** — `renderTryOn`/`renderLehengaCholiTryOn` gained two
  plain numeric knobs (`foreshortenFactor`, `viewAlpha`, both optional,
  default to a no-op) and know nothing about which image was chosen or why.
  All the "which piece, mirrored how" decision-making lives in App.tsx,
  which already owns `Garment`-typed state. `viewAlpha` is applied via
  `ctx.save()/globalAlpha/ctx.restore()` wrapped *only* around the garment
  layer's own draw call — occlusion patches (which restore original,
  fully-opaque frame pixels) are drawn after `restore()` and are therefore
  never faded, which matters: a faded-out arm-occlusion patch would look
  like a ghost limb.
- **Live-mode person depth is genuinely new, not just throttled** — before
  this phase, live mode had zero person-depth signal (occlusion always used
  the arm-capsule fallback, shading never got the depth-driven AO term)
  even with advanced mode on; `personDepthBitmap` in App.tsx only ever fed
  from photo-mode's `photoDepth`. `hooks/useLiveDepth.ts` adds this for live
  mode: its own ~5fps timer (independent of the ~15fps pose loop),
  downscaling the latest live frame to `config.liveDepth.maxDim` (256px)
  before calling `estimateDepth`, holding the previous result between
  ticks. WebGPU-only by construction (`enabled` requires
  `advanced.device === 'webgpu'`) — on wasm, depth is ~30s/frame (A1
  notes), so the hook simply never fires and live mode keeps today's
  arm-capsule/unshaded fallback, matching §5.5 exactly. No compositor
  changes were needed to consume a downscaled depth map: both
  `applyDepthOcclusion` and `applyGarmentShading` already scale `personDepth`
  up to the frame's own resolution via `drawImage(personDepth, 0, 0, w, h)`.
- **Back-view assets also get their own normal map** — extended the
  existing Phase A3 normal-map effect in App.tsx (same pattern as the
  lehenga-choli two-piece case) so a single-piece garment's `back` photo,
  when present, gets its own depth→normal pass too, used automatically
  whenever the live-mode back view is active. Not required by the phase's
  done-when, but skipping it would have made the back view visibly flatter
  than the front whenever shading is on — a jarring inconsistency for a
  feature literally about making orientation changes look natural.
- **Verification gap, stated plainly:** the sandboxed browser environment
  used to check this phase has no camera device, so the actual "turn
  around slowly and watch the garment foreshorten/fade/show its back" user
  experience could not be visually confirmed end-to-end. What WAS verified:
  all 24 new unit tests (`orientation.test.ts`, `anchorMapping.test.ts`)
  covering calibration growth/decay, the front/profile/back view-selection
  table (including the crossfade-ramp bug caught above), and the
  foreshorten-factor shape; a live Chrome check that photo mode is
  pixel-for-pixel unaffected (advanced mode + shading + a user-uploaded
  garment all render exactly as before) with zero console errors; and that
  toggling into/out of live mode (with the resulting camera-permission
  request left permanently unresolved, since no camera exists to grant)
  neither crashes nor logs errors. Whoever next has access to a real webcam
  should walk through the phase's actual done-when checklist (foreshorten
  to ±40°, full turn shows the back view for a back-capable asset,
  fade+hint for front-only, no smeared garment in the profile band) before
  fully trusting this phase in production.

## 1. Problem statement (from the product owner)

The current 2D TPS warp of flat garment PNGs onto pose keypoints produces
"sticker on a photo" results, blamed partly on poor garment assets. Desired
direction: AI-powered image-to-3D **in the browser** (depth estimation, or
full generative image-to-3D), where **users upload garment photos** and the
app drapes them onto their photo or live webcam.

**Hard product constraints (owner decisions, not suggestions):**

1. The simple app stays exactly as it is. Everything in this plan is an
   **opt-in advanced mode behind an explicit button** — the ~50MB of extra
   model weight must never load unless the user asks for it (§5.0).
2. A garment's back side is shown **only when the asset provides a back
   image** (catalog photo set or user-uploaded second photo). No back image
   → no back rendering; never fabricate one (§5.1, §5.4.3).

## 2. Why current results look flat (diagnosis first, tech second)

A 2D warp fails to convince for four reasons, in decreasing order of impact:

1. **No shading response** — the warped garment keeps the lighting baked into
   its product photo; it doesn't shade with the person's photo lighting or
   with body curvature. This is the single biggest "sticker" tell.
2. **Binary occlusion** — arms/hair either fully in front or fully behind
   (the current arm-capsule hack), no per-pixel depth ordering.
3. **No out-of-plane orientation** — a torso turned 30° should foreshorten
   the garment and reveal its side; TPS on 2D keypoints can only shear.
4. **Asset quality** — background-removal halos, wrinkles baked in weird
   positions, non-frontal product shots. Better assets help, but fixing
   assets alone cannot fix 1–3.

Any plan that only swaps assets (even 3D ones) without addressing shading and
occlusion will still look pasted-on. Conversely, depth+shading alone gets a
surprisingly large share of the "3D look" without any true 3D geometry.

## 3. Feasibility findings (researched 2026-07, verify at build time)

### 3a. In-browser monocular depth estimation — **FEASIBLE, production-ready**

- Depth Anything V2 Small runs **real-time in the browser** via
  transformers.js + WebGPU; ~50MB fp16 ONNX (≈25MB int8), maintained at
  [onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small).
  Also runs without transformers.js via plain onnxruntime-web
  ([akbartus/DepthAnything-on-Browser](https://github.com/akbartus/DepthAnything-on-Browser)).
- Cost model fit: model download is one-time (Cache API); inference is
  on-device — **zero marginal server cost**, consistent with this project's
  core thesis.

### 3b. In-browser 3D body pose — **FEASIBLE, production-ready**

- MediaPipe **BlazePose GHUM** (TF.js `pose-detection` API) outputs **33
  landmarks with z** at ~15fps in browsers, plus an optional person
  segmentation mask from the same network
  ([TF.js blog](https://blog.tensorflow.org/2021/08/3d-pose-detection-with-mediapipe-blazepose-ghum-tfjs.html),
  [MediaPipe pose landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)).
  Torso yaw/pitch derivable from shoulder/hip z-deltas — this unlocks
  orientation-aware warping (§2.3) and could replace BOTH current models
  (MoveNet + Selfie Segmenter) with one network. GHUM variant also exposes
  statistical body-mesh parameters if a proxy body mesh is ever needed (Tier B).

### 3c. In-browser generative image-to-3D — **NOT FEASIBLE (2026)**

- State-of-practice single-image-to-3D models — TRELLIS.2-4B, Hunyuan3D 2.1,
  Stable Fast 3D, TripoSR — need **6–24GB VRAM CUDA**; community-optimized
  TRELLIS still targets 8GB desktop GPUs
  ([survey](https://trellis2.app/blog/best-image-to-3d-models-huggingface),
  [Stability announcement](https://stability.ai/news-updates/triposr-3d-generation)).
  No WebGPU/ONNX-web ports exist; the 3D decoders use custom CUDA ops that
  onnxruntime-web does not support. Do not attempt client-side.
- **Deeper problem, independent of where it runs:** generic image-to-3D
  produces *closed, watertight, solid* meshes. A garment photographed flat
  becomes a statue-like slab — no neck opening, no armholes, not a thin
  shell. It cannot be "worn" or draped. Generic image-to-3D is the wrong
  tool for garments even server-side.
- Garment-*specific* single-image reconstruction that outputs simulation-
  ready cloth (open meshes + sewing patterns) exists as 2025–26 research —
  [Dress-1-to-3](https://dress-1-to-3.github.io/),
  [Image2Garment](https://arxiv.org/html/2601.09658),
  [Garment3DGen](https://arxiv.org/abs/2403.18816) (template mesh deformed
  under image guidance) — but it is research code, minutes of server GPU per
  garment, no hosted API yet. Watch this space; do not build v1 on it.

### 3d. In-browser cloth simulation & 3D rendering — **FEASIBLE**

- Real-time WebGPU cloth simulation at high resolution is demonstrated in the
  literature ([arXiv 2507.11794](https://arxiv.org/abs/2507.11794)) and in
  three.js community work (CLO3D garments driven in-browser). Only relevant
  for Tier B below.

### 3e. In-browser background removal for user uploads — **FEASIBLE**

- RMBG / BiRefNet-class matting models run in-browser via transformers.js
  (RMBG-1.4 is ~44MB ONNX). Needed because user garment photos arrive with
  backgrounds, and the current Selfie Segmenter only segments *people*.

## 4. Verdict

| Tier | What | Feasible? | Where it runs |
|---|---|---|---|
| **A** | 2.5D: depth + normals + shading + per-pixel occlusion + orientation-aware warp | **Yes — build this** | 100% browser |
| **B** | True 3D: one-time garment→cloth-mesh conversion, three.js draping on pose-driven proxy body | Partially — server does a **one-time per-garment** conversion; browser does all per-frame work | Hybrid |
| **C** | Full generative image-to-3D client-side | **No** (VRAM, missing ops, wrong mesh topology for cloth) | — |

**Recommendation:** build Tier A now — as an **opt-in "advanced" mode behind
an explicit button**, never as the default path (product owner decision; see
§5.0). It attacks all three root causes in §2 that assets can't fix, needs no
server, and works for user-uploaded garment photos. Design the garment-asset
schema so Tier B slots in later without another migration. Reject Tier C.

Tier B does *not* violate the zero-server-cost thesis if framed correctly:
conversion is **per garment, one-time** (catalog garments preprocessed
offline; a user-uploaded garment is one API call, cacheable forever), while
per-frame draping/rendering stays on-device. But its garment-reconstruction
dependency is research-grade today (§3c), so it is a design constraint now
and an implementation later.

## 5. Tier A architecture (the thing to build)

### 5.0 Advanced mode is opt-in (a button, not a default)

The existing flat pipeline **stays exactly as it is** and remains the
default experience — instant start, ~3MB of models. Everything in Tier A
lives behind an explicit **"Enhance (3D)" button**:

- Nothing from this plan downloads or initializes until the user clicks it.
  The ~25–50MB depth model (and matting model, when the upload flow needs
  it) load only then, with a visible download-progress indicator and a
  one-line size warning on the button itself (e.g. "Enhance (3D) · ~30MB
  one-time download").
- Once downloaded, models are cached (Cache API) and the preference persists
  (localStorage), so returning users who opted in get advanced mode without
  re-downloading — but it must remain a visible toggle they can switch off,
  and switching off returns to the flat pipeline immediately (no reload).
- If WebGPU is unavailable, the button either downgrades to photo-mode-only
  advanced (Wasm) or disables with an explanatory tooltip — feature-detect
  first, never let the user download 50MB into a pipeline that can't run it.
- Architecturally: one `renderMode: 'simple' | 'advanced'` flag in config,
  checked at the compositor entry point and the worker model-loading path.
  The simple path must never grow a dependency on any advanced-mode module
  (keep them in separate chunks so Vite code-splits them out of the initial
  bundle).

### 5.1 New garment asset schema (v2) — superset of today's

```jsonc
{
  "id": "user-upload-abc123",
  "category": "kurti",
  "image": "/garments/....png",        // RGBA, background removed (front view)
  "anchors": { ... },                   // unchanged 6-anchor set (front view)
  "depthMap": "/garments/....depth.png",   // NEW: grayscale, garment-relative depth
  "normalMap": "/garments/....normal.png", // NEW: derived from depthMap offline/at-upload
  "back": {                             // NEW, OPTIONAL: back view of the garment
    "image": "/garments/....back.png",
    "anchors": { ... },                 // 6-anchor set annotated on the back image
    "depthMap": "...", "normalMap": "..."  // optional, same as front
  },
  "meta": { ... }
}
```

- `depthMap`/`normalMap` are **optional** — existing catalog entries keep
  working (renderer falls back to today's flat composite). Generate them for
  catalog garments with a one-off Node script OR lazily in-browser on first
  selection, then cache (IndexedDB/Cache API).
- `back` is **optional and per-asset**: the back view can only be shown for
  garments whose photo set actually includes a back-side image (product
  owner decision). No back image → no back rendering, ever — never
  mirror/hallucinate the front as a fake back (prints, necklines, and
  closures differ front-to-back and a mirrored front reads as a bug).
- Lehenga-choli two-piece entries: each piece gets its own depth/normal pair,
  and its own optional `back` piece.
- Keep validation in `src/garments/schema.ts` style: additive, discriminated.

### 5.2 User garment upload pipeline (all in-browser, Web Worker)

```
user photo of garment
  → RMBG/BiRefNet background removal (transformers.js, WebGPU)
  → auto-crop to alpha bbox
  → Depth Anything V2 Small → garment depth map (one-time)
  → depth → normal map (Sobel on depth, pack to RGB; trivial shader/JS)
  → anchor placement: auto-suggest from mask silhouette
      (shoulders = top-width extrema, waist = min-width row, hem = bottom
      extrema — same geometry the annotate tool encodes), then let the user
      drag-adjust the 6 points (reuse tools/annotate.html logic as a React
      component)
  → OPTIONAL: "add back side?" step — user uploads a second photo of the
      garment's back; it runs through the same matting/depth/anchor flow
      and is stored as the asset's `back` piece. Skippable; most users
      will have only a front photo and that must stay a first-class asset.
  → save garment asset v2 to IndexedDB, appears in the picker
```

Anchor auto-suggestion quality gates the whole result (CLAUDE.md: "anchor
quality dominates output quality") — ship the drag-adjust UI, don't trust
auto-detection alone.

### 5.3 Person-side per-frame additions

```
frame → [existing] segmenter mask + pose keypoints
      → [NEW] Depth Anything V2 Small → person depth map
              (photo mode: every photo; live mode: every Nth frame at
               reduced resolution, e.g. 256px @ 5fps, cached between)
      → [NEW or replacing MoveNet] BlazePose GHUM 33× (x,y,z)
              → torso yaw ≈ atan2(Δz_shoulders, Δx_shoulders)
```

Evaluate replacing MoveNet+Selfie-Segmenter with BlazePose (it emits both
landmarks and a segmentation mask); if quality holds on the 5 test photos,
that's one model instead of two and z comes free. Otherwise add depth model
as a third worker model and keep MoveNet for 2D anchors.

### 5.4 Compositor upgrades (the visible wins)

Applied in this order, each independently demoable:

1. **Depth-tested occlusion** (replaces arm-capsule hack): garment pixel is
   drawn only where `personDepth(px) > garmentPlaneDepth(px)` with a soft
   threshold — arms, hair, held objects in front of the torso occlude
   correctly, per-pixel. GarmentPlaneDepth = person depth sampled along the
   torso anchor region, interpolated across the garment quad.
2. **Normal-map relighting**: estimate a single dominant light direction from
   the person photo (cheap: least-squares fit of shading gradient over the
   segmented face/skin region, or even a fixed top-left default with
   intensity from mean luminance); shade the garment with its normal map
   (Lambert + slight ambient) and *multiply out* its baked-in flat lighting.
   Also darken garment edges where body curvature turns away (screen-space
   AO approximation from person depth).
3. **Orientation-aware warp + view selection**: pre-rotate the garment quad
   by torso yaw (foreshorten horizontally around the spine axis, weight by
   depth map so the near side scales up) before the existing TPS solves
   residual fit. Which *view* renders is a pure function of yaw and what
   the asset provides:

   | Torso yaw (|θ| from frontal) | Asset has back | Asset front-only |
   |---|---|---|
   | 0–40° (facing camera) | front view | front view |
   | 40–140° (profile band) | fade out + "turn to face/away" hint | fade out + hint |
   | 140–180° (facing away) | **back view** | fade out + hint |

   Back-facing detection signal: BlazePose landmark z-order flips
   (left/right shoulder swap in x while nose/eye visibility scores drop) —
   robust and cheap; don't rely on yaw math alone near 180°. Anchor mapping
   for the back view mirrors L/R keypoint assignment (the person's left
   shoulder anchors the back image's *right*-side anchor). The profile band
   fades regardless of assets — flat views (front or back) fundamentally
   can't show a garment's side; be honest about it.
4. **Drape-line synthesis (stretch goal)**: use garment depth valleys
   (wrinkle lines) to anisotropically weight the TPS grid so wrinkles bend
   along body curvature instead of shearing rigidly.

### 5.5 Performance budget

| Item | Cost | Mitigation |
|---|---|---|
| DA-V2-small download | ~25–50MB one-time | lazy-load on first garment selection; Cache API; show progress |
| Person depth, photo mode | ~100–300ms/photo (WebGPU) | fine — photo mode is async already |
| Person depth, live mode | can't run 15fps alongside pose | run at 5fps on 256px input, temporally reuse; depth changes slowly relative to pose |
| Garment depth+matting | one-time per upload (~1–2s) | show "processing garment…" state |
| Normal-map shading | per-frame fragment work | do it in the existing canvas/WebGL compositor pass, not per-pixel JS |

CPU/Wasm fallback: depth at photo-mode only; live mode falls back to today's
pipeline (feature-detect and degrade gracefully — same pattern as the
existing WebGPU→Wasm fallback).

## 6. Tier B sketch (design for it now, build later)

- **Asset**: per category, a small library of base garment meshes (open,
  thin-shell, simulation-ready — author once in CLO3D/Marvelous or take from
  a Garment3DGen-style template set). A garment *instance* = base mesh +
  displacement + PBR texture, produced by a **one-time server conversion**
  (research pipelines in §3c, or a commercial API when one ships; watch
  Dress-1-to-3 / Image2Garment for code+weights).
- **Runtime**: three.js layer over the video canvas; proxy body capsule mesh
  driven by BlazePose GHUM (optionally its body-mesh params); garment mesh
  skinned/wrap-deformed to proxy body; WebGPU cloth solver ONLY if skinned
  draping proves insufficient (it's demonstrated feasible but is the hardest
  component — treat as optional polish, not the spine).
- **Cost framing**: one conversion per garment (~cents of GPU time), zero
  per-frame server cost. Catalog: preconverted. User uploads: convert once,
  cache by image hash.
- **Trigger to start building**: a garment-specific image-to-3D API or
  open-weights release that outputs open cloth meshes. Until then Tier A's
  schema (v2 + optional `mesh` field later = v3) keeps the door open.

## 7. Build phases (Tier A)

### Phase A1 — Advanced-mode gate + depth infrastructure
- Build the "Enhance (3D)" button and `renderMode` flag FIRST (§5.0):
  code-split chunk, download progress UI, Cache API caching, localStorage
  persistence, WebGPU feature-detect, instant switch-off. The simple app's
  initial bundle and startup must be byte-for-byte unaffected.
- Add transformers.js (or onnxruntime-web) in the advanced chunk; load
  DA-V2-small only after the button is clicked; run on photo + garment
  image; visualize depth as a debug overlay toggle (like mask/skeleton).
- **Done when:** simple mode ships unchanged (verify initial-bundle size
  before/after); clicking the button downloads with progress, then depth
  maps render as overlay for person photos and garment images on all 5 test
  photos; WebGPU + Wasm both verified; toggling off restores the flat
  pipeline without reload.

### Phase A2 — Depth-tested occlusion
- Replace arm-capsule occlusion with per-pixel depth compare (soft edge).
- **Done when:** crossed arms, hand-on-hip, and held-phone poses occlude the
  garment correctly on test photos; no regression on the 2 hip-length garments.

### Phase A3 — Relighting
- Depth→normal map generation; single-light estimation; Lambert shading pass
  in the compositor.
- **Done when:** side-lit test photo shows garment shaded from the same side;
  A/B toggle (flat vs shaded) demonstrates the difference for the demo.

### Phase A4 — User garment upload (front, optional back)
- In-browser matting (RMBG), auto-anchor suggestion, drag-adjust anchor UI,
  IndexedDB persistence, picker integration; optional "add back side" step
  running the same flow into the asset's `back` piece.
- **Done when:** a phone photo of a shirt on a bed becomes a working try-on
  garment in <60s without leaving the browser; adding a back photo makes the
  asset back-capable, skipping it leaves a working front-only asset.

### Phase A5 — Orientation-aware warp, view selection + live-mode depth throttling
- Torso yaw from BlazePose z (or interim: shoulder-width-ratio heuristic);
  pre-rotation before TPS; live-mode 5fps depth with temporal reuse; the
  yaw→view policy from §5.4.3 (front / fade+hint / back-if-provided), with
  back-facing detection from landmark L/R flip + face-visibility drop and
  mirrored anchor assignment for the back view.
- **Done when:** slow torso rotation in live mode foreshortens the garment
  plausibly to ±40°; turning fully around shows the back view for a
  back-capable asset (test with one catalog garment given a real back
  photo) and the fade+hint for front-only assets; the profile band never
  renders a smeared garment.

Phases A1–A3 are pure additive rendering work with the existing two models;
A4 introduces one new model (matting); A5 may swap the pose model. Each phase
is independently demoable (portfolio requirement from CLAUDE.md).

## 8. Risks / honest limitations

- **Flat-view ceiling:** front (and, when provided, back) photos still can't
  show a garment's true side — the 40–140° profile band fades out by design.
  Tier A is "2.5D": convincing near frontal, honest everywhere else. Never
  synthesize a back by mirroring the front. Set the expectation in the UI;
  don't chase profile views in code.
- **Depth model on garments:** DA-V2 is trained on scenes, not product shots;
  garment depth maps will be plausible-relative, not metric. That's fine —
  only *relative* depth (wrinkles, drape direction) is used.
- **Model weight budget:** +25–50MB is a real download for a demo site —
  which is exactly why advanced mode is opt-in behind a button (§5.0). The
  flat pipeline is the instant-start default; the download happens once,
  with progress shown, only for users who ask for it.
- **Live-mode frame budget:** three models (pose+segment+depth) at 15fps is
  optimistic on mid-range hardware even with WebGPU; the 5fps-depth
  interleave in §5.5 is load-bearing, not optional.
- **User-upload abuse/quality:** wrinkled garments photographed at angles
  will produce mediocre anchors and depth; the drag-adjust UI and a "retake
  photo flat, from above" guidance screen matter more than model quality.

## 9. Verification (beyond per-phase "done when")

- Existing 17 unit tests keep passing; new pure functions (depth→normal,
  yaw-from-landmarks, anchor auto-suggest) get unit tests with golden inputs.
- Visual regression: screenshot the 5 test photos × 3 garments before/after
  each phase; compare side-by-side (manual is fine, this is a portfolio
  project).
- Perf: FPS meter must show ≥12fps live on the dev machine with depth
  interleaving on; WebGPU→Wasm fallback path exercised each phase.

## 10. Sources

- https://huggingface.co/onnx-community/depth-anything-v2-small
- https://github.com/akbartus/DepthAnything-on-Browser
- https://blog.tensorflow.org/2021/08/3d-pose-detection-with-mediapipe-blazepose-ghum-tfjs.html
- https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
- https://trellis2.app/blog/best-image-to-3d-models-huggingface
- https://stability.ai/news-updates/triposr-3d-generation
- https://dress-1-to-3.github.io/
- https://arxiv.org/html/2601.09658 (Image2Garment)
- https://arxiv.org/abs/2403.18816 (Garment3DGen)
- https://arxiv.org/abs/2507.11794 (WebGPU cloth simulation limits)
