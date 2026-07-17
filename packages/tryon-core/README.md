# @practics/tryon-core

A framework-free virtual try-on pipeline: person segmentation, pose
estimation, thin-plate-spline garment warp, and mask/depth-aware
compositing — all on-device, no server, embeddable in any app.

Extracted from [pravoobi/try-on](https://github.com/pravoobi/try-on), a
real-time browser try-on app. This package **is** that app's pipeline —
the app itself is a thin React/UI shell around it, built with
[`litert-react`](https://www.npmjs.com/package/litert-react)
for the Worker/model-loading integration and
[`thin-plate-spline`](https://www.npmjs.com/package/thin-plate-spline) for
the image warp.

No React, no DOM assumptions beyond canvas/`ImageBitmap`/`Worker` — usable
from a Web Worker or the main thread, in any frontend framework or none.

**Topics:** `virtual-try-on` `on-device-ml` `computer-vision`
`pose-estimation` `segmentation` `thin-plate-spline` `litert` `webgpu` — see
the [source repo's GitHub topics](https://github.com/pravoobi/try-on) for
the full list across all three packages extracted from it.

## Install

```bash
npm install @practics/tryon-core
```

`@litertjs/core`, `@tensorflow/tfjs-*`, and `@huggingface/transformers` come
along as regular dependencies (this package's actual inference runtime, not
something you provide yourself).

## What's in here

- **`Segmenter`** / **`PoseEstimator`** (`segmenter.ts`/`pose.ts`) — LiteRT.js
  model wrappers: person-confidence mask, 17-keypoint pose.
- **`renderOutfitTryOn`** (`compositor.ts`) — the general per-frame render:
  an optional top piece (shirt/tshirt/kurti/dress) and/or an optional pants
  piece composited in one pass — pants first, top over the waistband seam —
  each warped onto detected body anchors and clipped to the person mask
  (pants fitted everywhere; a knee/ankle top's hem drapes free), then
  arm/hair pixels restored in front of the fabric. Depth-tested occlusion
  and Lambertian relighting kick in automatically when you pass a person
  depth map / garment normal maps; otherwise it falls back to a lighter
  heuristic (arm-capsule occlusion, flat shading). **`renderTryOn`** /
  **`renderPantsTryOn`** are single-piece conveniences over it;
  **`renderLehengaCholiTryOn`** handles the two-piece lehenga ensemble.
- **`computeBodyAnchors`** / **`computeLehengaSkirtBodyAnchors`** /
  **`computePantsBodyAnchors`** (`anchorMapping.ts`) — maps pose keypoints
  to the anchor targets a garment's warp is fit to (shoulders direct, waist
  interpolated, hem extrapolated per garment length; pants hems track each
  leg's own knee/ankle keypoint).
- **`suggestAnchors`** / **`cropToAlphaBBox`** (`autoAnchor.ts`) — auto-suggests
  those same 6 anchors from a background-removed garment photo's alpha
  silhouette, for a garment-upload flow's starting point.
- **`extractGarmentAlpha`** (`garmentExtract.ts`) — given a matted (background
  removed) photo of someone *wearing* a garment, plus a clothes-parsing
  model's per-pixel labels, strips the wearer and keeps just the garment.
- **`updateSwipeDetection`** (`gesture.ts`) — hands-free left/right/up/down
  swipe detection from wrist keypoints alone (no camera access beyond what
  you already have for pose estimation). Frame-rate independent (a swipe is
  judged by real-time span, not sample count), with return-stroke
  suppression (the hand traveling back doesn't fire the opposite swipe) and
  an above-the-shoulders gate on "up".
- **`estimateTorsoOrientation`** / **`selectGarmentView`** (`orientation.ts`)
  — live-mode yaw estimation (shoulder-width heuristic) and front/back/
  profile view selection + fade, for a garment with a back photo.
- **`OneEuroKeypointSmoother`** (`smoothing.ts`) — One Euro filtering across
  frames to kill live-video jitter: heavy smoothing at standstill, near-raw
  during fast motion, stable across varying tick rates. (`smoothKeypoints`,
  the simpler fixed-alpha EMA, is still exported.)
- **`computeLetterbox`** / **`unletterboxPoint`** (`letterbox.ts`) — square
  model-input padding math, and mapping keypoints back out of it.
- **`depthToNormalMap`** (`normalMap.ts`) — derives a normal map from a
  garment's own depth estimate, for relighting.
- **Ready-made Worker factories** (`@practics/tryon-core/workers`) —
  `createInferenceWorker()`, `createMattingWorker()`, `createDepthWorker()`:
  each spins up one of this package's three workers (segmentation+pose,
  garment-upload matting/parsing, depth estimation) with zero
  bundler-specific setup on your end.
- **`DEFAULT_CONFIG`** / **`resolveTryOnConfig`** (`config.ts`) — every
  tunable used above, with the reference app's exact defaults. Every
  function that needs tuning takes it as an explicit parameter — nothing in
  this package reaches into a global — so override any subset you want.

## Usage sketch

```ts
import { createInferenceWorker } from '@practics/tryon-core/workers';
import { renderTryOn, smoothKeypoints, type PipelineResult } from '@practics/tryon-core';

const worker = createInferenceWorker();
worker.postMessage({
  type: 'init',
  wasmPath: '/litert-wasm/',       // your own hosted copy of the LiteRT.js wasm runtime
  modelPaths: { segmenter: '/models/selfie_segmenter.tflite', pose: '/models/movenet_singlepose_lightning.tflite' },
  accelerator: 'webgpu',
});

// ... on 'result' messages, you have { keypoints, maskBitmap, timings }.
// Composite it onto a canvas:
const ctx = canvas.getContext('2d')!;
renderTryOn(ctx, {
  frame,                    // the ImageBitmap you sent for inference
  maskBitmap: result.maskBitmap,
  keypoints: result.keypoints,
  garmentImage,              // your garment's cropped, background-removed photo
  garmentAnchors,            // that photo's 6 anchor points (see autoAnchor.ts)
  hemLength: 'knee',
});
```

Pair this with
[`litert-react`](https://www.npmjs.com/package/litert-react)
for the React hooks side (model loading state, Worker RPC, frame
throttling) — see its README for the full loop.

## Models

The reference app's model choices (you can point `modelPaths`/matting/depth
init messages at any LiteRT/transformers.js-compatible model of the same
task):

| Task | Model | Input | Output |
|---|---|---|---|
| Segmentation | MediaPipe Selfie Segmenter | 256×144 float32 | low-res person-confidence mask |
| Pose | MoveNet SinglePose Lightning | 192×192 int32 RGB | 17 keypoints (COCO order) |
| Matting (upload) | MODNet | any | soft foreground alpha |
| Clothes parsing (upload) | SegFormer-B2 human-parsing | any | per-pixel garment/body-part labels |
| Depth (advanced mode) | Depth-Anything-V2-small | any | monocular depth map |

## License

MIT
