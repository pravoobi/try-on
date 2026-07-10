# CLAUDE.md — Virtual Try-On (Browser-Native, LiteRT.js)

## What this project is

A browser-based virtual try-on app that runs entirely client-side using
LiteRT.js (Google's web AI inference runtime) with WebGPU acceleration.
Users see garments (western dresses, tops, kurtis, lehengas — sarees later)
overlaid on themselves in real time via webcam or on an uploaded photo.

**Zero server inference cost.** All ML runs on-device. This is the core
architectural thesis and the business differentiator: free real-time preview
in the browser, with an optional future paid tier calling a server-side
diffusion model (IDM-VTON class) for photorealistic HD renders.

**Positioning:** portfolio piece demonstrating on-device ML architecture for
Lead/Architect frontend roles, and a prototype for a B2B try-on SaaS aimed at
small/mid e-commerce sellers (Indian ethnic wear as the wedge market).

## Architecture overview

Pipeline per frame (or per uploaded photo):

1. **Person segmentation** → body mask (MediaPipe Selfie Segmenter, TFLite)
2. **Pose estimation** → 17 keypoints (MoveNet SinglePose Lightning, TFLite)
3. **Garment warping** → thin-plate-spline (TPS) warp of pre-annotated
   garment PNG anchors onto detected keypoints (pure TypeScript, no ML)
4. **Compositing** → layer warped garment over video frame using the
   segmentation mask for occlusion (arms render in front of fabric)

Inference runs in a Web Worker. Rendering on main thread via canvas/WebGL.

```
webcam/photo ──► [Worker: LiteRT.js]
                   ├─ segmenter ──► mask ─────────┐
                   └─ pose ──► keypoints ─► TPS ──┤
                                                  ▼
main thread ◄──────────────────── compositor (canvas/WebGL)
```

## Repo structure

```
src/
  pipeline/
    segmenter.ts      # LiteRT.js wrapper: load model, run, return mask
    pose.ts           # LiteRT.js wrapper: keypoint extraction + smoothing
    warp.ts           # TPS implementation (pure TS, no deps)
    compositor.ts     # canvas layering: frame → warped garment → occlusion
    types.ts          # Keypoint, Mask, GarmentAnchors, PipelineResult
  garments/
    schema.ts         # garment anchor JSON schema + validation
    catalog.json      # garment registry (id, category, image, anchors)
  workers/
    inference.worker.ts   # owns both models; postMessage protocol
  components/         # React UI: video canvas, garment picker, FPS meter
  hooks/              # useWebcam, usePipeline, useGarmentCatalog
public/
  models/             # .tflite files (see Models section)
  garments/           # background-removed garment PNGs + anchor JSONs
tools/
  annotate.html       # standalone annotation tool (no build step):
                      # load garment PNG, click anchor points, export JSON
```

## Stack

- **Runtime:** LiteRT.js (`@litertjs/core`), WebGPU backend, CPU (Wasm/XNNPack) fallback
- **App:** React + TypeScript + Vite
- **No CSS framework required**; keep UI minimal, the pipeline is the product
- **No server.** Static hosting (Vercel / GitHub Pages)

## Models

| Task | Model | File | Input | Output |
|---|---|---|---|---|
| Segmentation | MediaPipe Selfie Segmenter (landscape) | ~250KB .tflite | 256×144 float32, normalized 0-1 | low-res confidence mask |
| Pose | MoveNet SinglePose Lightning | ~3MB .tflite | 192×192 int32 RGB | [1,1,17,3] → (y, x, score) per keypoint |

Sources: Kaggle Models / MediaPipe model pages (TFLite format — this is what
LiteRT.js consumes directly). Verify current LiteRT.js model-loading API
against docs at build time; the library is new (announced July 2026) and
APIs may shift.

MoveNet keypoint indices used for garment anchoring:
5/6 = shoulders, 11/12 = hips. Elbows (7/8) and knees (13/14) used only for
long sleeves / hem length checks.

## Garment data model

Each garment = background-removed PNG + anchor JSON:

```json
{
  "id": "kurti-blue-01",
  "category": "kurti | dress | top | lehenga | saree",
  "image": "/garments/kurti-blue-01.png",
  "anchors": {
    "shoulderL": [x, y],
    "shoulderR": [x, y],
    "waistL": [x, y],
    "waistR": [x, y],
    "hemL": [x, y],
    "hemR": [x, y]
  },
  "meta": { "sleeves": "full | half | sleeveless", "length": "hip | knee | ankle" }
}
```

Anchors are in garment-image pixel coordinates. Runtime maps them to detected
body keypoints (shoulders→shoulders, waist→interpolated between shoulders and
hips, hem→extrapolated below hips per `meta.length`).

### Garment categories — difficulty order (build in this order)

1. **Tops / t-shirts / kurtis** — fitted, torso-anchored. Easiest. Start here.
2. **Western dresses (A-line, bodycon, maxi)** — same anchors + hem
   extrapolation. Fitted silhouettes warp convincingly.
3. **Lehenga-choli** — treat as two garments (choli = top, lehenga = skirt
   anchored at waist/hem). Composite both.
4. **Sarees — deferred.** Draped, not worn; 2D warping of a flat garment
   image does not work. Approach when ready: pre-rendered drape templates
   per style (Nivi, Bengali) annotated as a unit and warped whole. This is
   the long-term moat, not the prototype.

## Build phases

### Phase 1 — Pipeline proof (static image)
- Vite + React scaffold, LiteRT.js in a Web Worker from day one
- Upload photo → run segmenter + pose → draw mask overlay and keypoint
  skeleton on canvas
- **Done when:** keypoints and mask render correctly on 5 test photos,
  WebGPU backend confirmed active (log backend), CPU fallback works

### Phase 2 — Garment overlay (static image)
- Build `tools/annotate.html`: load PNG, click 6 anchors, export JSON
- Implement `warp.ts` (TPS) and `compositor.ts`
- Annotate 2 kurtis + 2 western dresses; composite onto test photos
- Occlusion: garment layer masked so body regions in front (arms) show through
- **Done when:** a dress visually "fits" on 3 different body poses

### Phase 3 — Live webcam
- `getUserMedia` → throttled inference (~15fps target)
- Exponential smoothing on keypoints between frames (kill jitter):
  `smoothed = α·new + (1−α)·prev`, α ≈ 0.3-0.5, tune visually
- Garment switcher UI
- **Done when:** live try-on holds stable while user moves normally

### Phase 4 — Portfolio polish
- FPS counter + WebGPU/CPU toggle (demo talking point: show the speedup)
- Deploy static build; README with architecture diagram + demo GIF
- Write-up framing: on-device ML architecture, privacy (video never leaves
  device), zero-inference-cost economics

## Known gotchas (do not rediscover these)

- **Input preprocessing:** MoveNet wants 192×192 **int32**; segmenter wants
  normalized float32. Getting dtype/normalization wrong fails silently with
  garbage outputs. Validate against a known-good test image first.
- **Mask upscaling:** segmentation output is low-res. Bilinear-upscale the
  mask before compositing and feather edges (small blur on mask alpha),
  otherwise hard halo artifacts around the person.
- **GPU↔CPU transfer is the bottleneck**, not inference. Keep video-frame →
  tensor conversion on GPU where LiteRT.js tfjs-interop allows. Avoid
  reading pixels back to CPU per frame.
- **Worker protocol:** transfer `ImageBitmap` / `OffscreenCanvas` to the
  worker, not raw pixel arrays via structured clone.
- **Aspect ratios:** model inputs are square/fixed; letterbox-pad video
  frames, don't stretch, and un-letterbox keypoint coordinates on the way
  out or garments land in the wrong place.
- **Anchor quality dominates output quality.** If a garment looks wrong,
  fix its anchors before touching warp code.

## Conventions

- TypeScript strict mode; no `any` in `pipeline/`
- `pipeline/` modules are framework-free (no React imports) — testable in
  isolation and reusable if UI layer changes
- All model paths, thresholds (keypoint confidence min 0.3, smoothing α,
  target fps) live in a single `config.ts`
- Commit working phase checkpoints; each phase is independently demoable

## Explicit non-goals (v1)

- No photorealistic rendering (that's the future server-side paid tier)
- No saree support in v1 (see difficulty order)
- No user accounts, no backend, no analytics
- No multi-person support (MoveNet SinglePose is deliberate)
