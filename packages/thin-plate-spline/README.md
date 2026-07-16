# thin-plate-spline

Thin-plate-spline (TPS) image warping for canvas / `OffscreenCanvas`. Give it
an arbitrary set of source → destination point correspondences (≥3,
non-collinear) and it warps an image to match, rendered as a coarse grid of
affine-textured triangles — canvas 2D can only do affine transforms, so a full
nonlinear TPS warp is approximated locally per triangle.

Zero runtime dependencies. Works in a Worker or the main thread.

Extracted from [pravoobi/try-on](https://github.com/pravoobi/try-on)'s virtual
try-on garment warp, where it maps a flat garment photo's shoulder/waist/hem
anchors onto a detected body pose — but the API itself has no notion of
garments, bodies, or any fixed anchor count. It's just point-correspondence
image warping.

**Topics:** `thin-plate-spline` `tps` `image-warp` `canvas` `offscreencanvas`
`warp` `mesh-warp` — see the [source repo's GitHub
topics](https://github.com/pravoobi/try-on) for the full list across all
three packages extracted from it.

## Install

```bash
npm install thin-plate-spline
```

## Usage

```ts
import { renderGarmentWarp, ThinPlateSpline, type Point } from 'thin-plate-spline';

// Low-level: just the point-correspondence math.
const src: Point[] = [[0, 0], [100, 0], [0, 100], [100, 100]];
const dst: Point[] = [[10, 5], [120, 0], [0, 90], [110, 100]];
const tps = new ThinPlateSpline(src, dst);
tps.eval([50, 50]); // -> warped [x, y]

// High-level: warp an actual image onto a canvas given the same correspondences.
const canvas = renderGarmentWarp(
  imageBitmap,       // CanvasImageSource with width/height
  srcAnchors,        // Point[] in the image's own pixel space
  dstAnchors,        // Point[] in output pixel space
  outputWidth,
  outputHeight,
);
// canvas is an OffscreenCanvas — draw it, transfer it, or read its pixels.
```

### `renderGarmentWarp` options

```ts
renderGarmentWarp(
  image, srcAnchors, dstAnchors, outputWidth, outputHeight,
  grid = { cols: 16, rows: 24 },  // warp mesh resolution — higher = smoother, slower
  marginXFrac = 0.6,               // how far past the anchors' bbox to sample, as a
  marginYFrac = 0.15,               // fraction of the bbox's own width/height
)
```

Keep the margin modest: pixels far outside the control points' convex hull are
where TPS extrapolation gets unstable and can visibly fold.

## API

- **`ThinPlateSpline`** — `new ThinPlateSpline(src: Point[], dst: Point[])`,
  `.eval(p: Point): Point`. Throws if `src`/`dst` differ in length, have fewer
  than 3 points, or are collinear (a singular system).
- **`renderGarmentWarp(image, srcAnchors, dstAnchors, outputWidth, outputHeight, grid?, marginXFrac?, marginYFrac?)`**
  → `OffscreenCanvas`.
- **`Point`** = `readonly [number, number]`.
- **`WarpGridOptions`** = `{ cols: number; rows: number }`, and
  **`DEFAULT_WARP_GRID`** = `{ cols: 16, rows: 24 }`.

## License

MIT
