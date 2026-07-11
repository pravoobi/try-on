# Plan: AI-powered 3D-ish garment assets (depth-augmented try-on, user-uploaded garments)

**Status:** feasibility-checked, not started. This document is written for an
implementing agent/model with access to this repo; it assumes CLAUDE.md has
been read. Verify library APIs at build time — the browser-ML ecosystem moves
fast.

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
