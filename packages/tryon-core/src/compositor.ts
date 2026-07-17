/**
 * Composites a warped garment onto a photo: frame → warped garment (shaded
 * per-pixel against an estimated light when an advanced-mode normal map is
 * available — Phase A3, see applyGarmentShading) → clipped to the feathered
 * person mask, so fabric never spills onto the background → occlusion
 * patches restoring frame pixels wherever the person is in front of the
 * fabric. Occlusion has two implementations (see applyDepthOcclusion vs
 * drawArmOcclusion below): depth-tested when an advanced-mode person depth
 * map is available (Phase A2), else the arm-capsule heuristic (see
 * CLAUDE.md Phase 2 occlusion note) simple mode has always used.
 *
 * Also covers the lehenga-choli case (renderLehengaCholiTryOn): two
 * independently-photographed pieces, each warped on its own anchor set and
 * composited before the mask clip — see CLAUDE.md's garment difficulty
 * order ("treat as two garments... composite both").
 */
import { renderGarmentWarp, type WarpGridOptions } from 'thin-plate-spline';
import {
  computeBodyAnchors,
  computeLehengaSkirtBodyAnchors,
  computePantsBodyAnchors,
  foreshortenAnchors,
} from './anchorMapping.js';
import { resolveTryOnConfig, type PartialTryOnConfig, type TryOnConfig } from './config.js';
import { clipToMask, openMaskBelow, renderFeatheredMask } from './maskRender.js';
import { applyGarmentShading, estimateLight, type ShadingBBox } from './relight.js';
import {
  ANCHOR_NAMES,
  SKIRT_ANCHOR_NAMES,
  type BodyAnchors,
  type DepthMapSource,
  type GarmentAnchors,
  type HemLength,
  type Keypoint,
  type Point,
  type SkirtAnchors,
} from './types.js';

type Canvas2DContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface TryOnInput {
  frame: ImageBitmap;
  maskBitmap: ImageBitmap;
  keypoints: readonly Keypoint[];
  garmentImage: CanvasImageSource & { width: number; height: number };
  garmentAnchors: GarmentAnchors;
  hemLength: HemLength;
  warpGrid?: WarpGridOptions;
  armOcclusion?: boolean;
  /** Fraction of shoulder-to-shoulder width used as the occlusion capsule radius (fallback path only). */
  armOcclusionRadiusFactor?: number;
  /** Advanced-mode person depth map (Phase A2) — when present, occlusion is
   * depth-tested per-pixel instead of the arm-capsule heuristic. Any
   * resolution (scaled up to the frame internally — live mode passes a
   * downscaled one, see hooks/useLiveDepth.ts). */
  personDepth?: DepthMapSource | null;
  /** Advanced-mode garment normal map (Phase A3), same pixel space/coverage
   * as `garmentImage` — when present, the garment is Lambertian-shaded
   * against a light estimated from `frame` before compositing. */
  garmentNormal?: (CanvasImageSource & { width: number; height: number }) | null;
  /** Live-mode orientation-aware warp (Phase A5, see pipeline/orientation.ts
   * foreshortenFactor): horizontal squeeze of the body-anchor targets
   * toward their own centroid, 1 = none. Undefined/1 leaves photo mode
   * (and any caller that doesn't track orientation) unaffected. */
  foreshortenFactor?: number;
  /** Live-mode view fade (Phase A5, see pipeline/orientation.ts
   * selectGarmentView): overall garment-layer opacity, e.g. faded toward
   * transparent through the unrenderable profile band. Undefined/1 = fully
   * opaque, matching today's behavior. */
  viewAlpha?: number;
  /** Tuning override for anchor placement, relighting, and depth occlusion — any subset of any section; omitted sections/fields fall back to DEFAULT_CONFIG (see config.ts). */
  config?: PartialTryOnConfig;
}

export type TryOnStatus = 'ok' | 'pose-not-anchorable';

/** One top-like piece of an outfit (see OutfitTryOnInput). */
export interface OutfitTopPiece {
  image: CanvasImageSource & { width: number; height: number };
  anchors: GarmentAnchors;
  hemLength: HemLength;
  /** Advanced-mode normal map (Phase A3), same pixel space/coverage as `image`. */
  normal?: (CanvasImageSource & { width: number; height: number }) | null;
}

/** The pants/shorts piece of an outfit (see PantsTryOnInput for anchor semantics). */
export interface OutfitPantsPiece {
  image: CanvasImageSource & { width: number; height: number };
  anchors: SkirtAnchors;
  hemLength: HemLength;
  normal?: (CanvasImageSource & { width: number; height: number }) | null;
}

export interface OutfitTryOnInput {
  frame: ImageBitmap;
  maskBitmap: ImageBitmap;
  keypoints: readonly Keypoint[];
  /** Upper-body piece (shirt/tshirt/top/kurti/dress) — optional; an outfit can be pants-only. */
  top?: OutfitTopPiece | null;
  /** Lower-body piece — optional; an outfit can be top-only. */
  pants?: OutfitPantsPiece | null;
  warpGrid?: WarpGridOptions;
  armOcclusion?: boolean;
  armOcclusionRadiusFactor?: number;
  personDepth?: DepthMapSource | null;
  /** See TryOnInput.foreshortenFactor (Phase A5) — applied to every piece's body-anchor targets. */
  foreshortenFactor?: number;
  /** See TryOnInput.viewAlpha (Phase A5) — applied to the whole outfit. */
  viewAlpha?: number;
  config?: PartialTryOnConfig;
}

/**
 * The general try-on pass: frame → pants layer → top layer → occlusion.
 * Pants draw first and the top over them, so a hip-length top's hem covers
 * the pants waistband (the same seam-hiding order renderLehengaCholiTryOn
 * uses for skirt/choli). Each piece gets its own clip: pants are fitted
 * (full person-mask clip — keeps the leg gap open and snaps the anchor-less
 * inner-leg edges to the legs), a top opens the clip below its waist when
 * knee/ankle length so the hem drapes free. Arm/hand occlusion runs only
 * when a top is present — both occlusion implementations are parameterized
 * around torso anchors a pants-only outfit doesn't have.
 *
 * renderTryOn and renderPantsTryOn are thin wrappers over this.
 */
export function renderOutfitTryOn(ctx: Canvas2DContext, input: OutfitTryOnInput): TryOnStatus {
  const { frame, maskBitmap, keypoints } = input;
  const w = frame.width;
  const h = frame.height;
  const config = resolveTryOnConfig(input.config);
  const warpGrid = input.warpGrid ?? config.warpGrid;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(frame, 0, 0);

  const top = input.top ?? null;
  const pants = input.pants ?? null;
  if (!top && !pants) return 'ok';

  const foreshorten = input.foreshortenFactor ?? 1;
  // Both anchor computations share the same torso-confidence gate, so if
  // either present piece can't anchor, neither can — one status covers all.
  let topBody: BodyAnchors | null = null;
  if (top) {
    const raw = computeBodyAnchors(keypoints, top.hemLength, config);
    if (!raw) return 'pose-not-anchorable';
    topBody = foreshortenAnchors(raw, foreshorten);
  }
  let pantsBody: SkirtAnchors | null = null;
  if (pants) {
    const raw = computePantsBodyAnchors(keypoints, pants.hemLength, config);
    if (!raw) return 'pose-not-anchorable';
    pantsBody = foreshortenAnchors(raw, foreshorten);
  }

  // Light estimation reads the whole frame — compute once, only if some
  // piece actually has a normal map to shade with.
  let light: ReturnType<typeof estimateLight> | null = null;
  const getLight = () => (light ??= estimateLight(frame, maskBitmap, w, h, config.relighting));

  const feathered = renderFeatheredMask(maskBitmap, w, h);
  const layers: OffscreenCanvas[] = [];

  if (pants && pantsBody) {
    const src: Point[] = SKIRT_ANCHOR_NAMES.map((n) => pants.anchors[n]);
    const dst: Point[] = SKIRT_ANCHOR_NAMES.map((n) => pantsBody[n]);
    let layer = renderGarmentWarp(pants.image, src, dst, w, h, warpGrid);
    if (pants.normal) {
      const normalLayer = renderGarmentWarp(pants.normal, src, dst, w, h, warpGrid);
      const bbox = toPixelBBox(expandBBox(bboxOfPoints(dst), config.relighting.bboxMarginFrac, w, h));
      layer = applyGarmentShading(layer, normalLayer, getLight(), bbox, w, h, config.relighting, input.personDepth);
    }
    layers.push(clipToMask(layer, w, h, feathered));
  }

  if (top && topBody) {
    const src: Point[] = ANCHOR_NAMES.map((n) => top.anchors[n]);
    const dst: Point[] = ANCHOR_NAMES.map((n) => topBody[n]);
    let layer = renderGarmentWarp(top.image, src, dst, w, h, warpGrid);
    if (top.normal) {
      const normalLayer = renderGarmentWarp(top.normal, src, dst, w, h, warpGrid);
      const bbox = toPixelBBox(expandedAnchorBBox(topBody, config.relighting.bboxMarginFrac, w, h));
      layer = applyGarmentShading(layer, normalLayer, getLight(), bbox, w, h, config.relighting, input.personDepth);
    }
    // A hip-length top is fitted everywhere, so the person mask clips all of
    // it; a knee/ankle garment hangs free below the waist — open the clip
    // there so the hem drapes over the background and the gap between legs.
    // Open blend is generous (fitted at the waist, free by mid-thigh); the
    // hem cut is tight — junk in background-removed garment photos (the
    // original model's shoes) starts right at the hem line.
    const waistY = (topBody.waistL[1] + topBody.waistR[1]) / 2;
    const hemY = (topBody.hemL[1] + topBody.hemR[1]) / 2;
    const skirtLen = hemY - waistY;
    const clipMask =
      top.hemLength === 'hip'
        ? feathered
        : openMaskBelow(feathered, waistY, skirtLen * 0.2, hemY + skirtLen * 0.03, skirtLen * 0.05);
    layers.push(clipToMask(layer, w, h, clipMask));
  }

  ctx.save();
  ctx.globalAlpha = input.viewAlpha ?? 1;
  for (const layer of layers) ctx.drawImage(layer, 0, 0);
  ctx.restore();

  if (topBody && input.armOcclusion !== false) {
    if (input.personDepth) {
      applyDepthOcclusion(ctx, frame, input.personDepth, keypoints, topBody, w, h, config);
    } else {
      drawArmOcclusion(ctx, frame, keypoints, topBody, input.armOcclusionRadiusFactor ?? config.armOcclusionRadiusFactor);
    }
  }

  return 'ok';
}

/**
 * Draws the composited result into `ctx` (sized frame.width x frame.height).
 * Returns 'pose-not-anchorable' (and draws just the frame) when the torso
 * isn't confidently visible enough to place the garment.
 */
export function renderTryOn(ctx: Canvas2DContext, input: TryOnInput): TryOnStatus {
  return renderOutfitTryOn(ctx, {
    frame: input.frame,
    maskBitmap: input.maskBitmap,
    keypoints: input.keypoints,
    top: {
      image: input.garmentImage,
      anchors: input.garmentAnchors,
      hemLength: input.hemLength,
      normal: input.garmentNormal,
    },
    warpGrid: input.warpGrid,
    armOcclusion: input.armOcclusion,
    armOcclusionRadiusFactor: input.armOcclusionRadiusFactor,
    personDepth: input.personDepth,
    foreshortenFactor: input.foreshortenFactor,
    viewAlpha: input.viewAlpha,
    config: input.config,
  });
}

export interface LehengaCholiTryOnInput {
  frame: ImageBitmap;
  maskBitmap: ImageBitmap;
  keypoints: readonly Keypoint[];
  choliImage: CanvasImageSource & { width: number; height: number };
  choliAnchors: GarmentAnchors;
  lehengaImage: CanvasImageSource & { width: number; height: number };
  lehengaAnchors: SkirtAnchors;
  /** The lehenga's hem length (knee/ankle) — the choli's own hem is always the natural waistline. */
  skirtLength: HemLength;
  warpGrid?: WarpGridOptions;
  armOcclusion?: boolean;
  armOcclusionRadiusFactor?: number;
  personDepth?: DepthMapSource | null;
  /** Advanced-mode normal maps (Phase A3) for each piece, same pixel space/coverage as their respective images. */
  choliNormal?: (CanvasImageSource & { width: number; height: number }) | null;
  lehengaNormal?: (CanvasImageSource & { width: number; height: number }) | null;
  /** See TryOnInput.foreshortenFactor (Phase A5) — applied to both pieces' body-anchor targets. */
  foreshortenFactor?: number;
  /** See TryOnInput.viewAlpha (Phase A5). */
  viewAlpha?: number;
  /** See TryOnInput.config. */
  config?: PartialTryOnConfig;
}

/**
 * Same idea as renderTryOn but for a two-piece lehenga-choli: the skirt is
 * warped and drawn first, the choli on top of it (so the choli's hem
 * covers the waist seam), both clipped to the mask as one combined layer.
 */
export function renderLehengaCholiTryOn(ctx: Canvas2DContext, input: LehengaCholiTryOnInput): TryOnStatus {
  const { frame, maskBitmap, keypoints, choliImage, choliAnchors, lehengaImage, lehengaAnchors, skirtLength } = input;
  const w = frame.width;
  const h = frame.height;
  const config = resolveTryOnConfig(input.config);
  const warpGrid = input.warpGrid ?? config.warpGrid;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(frame, 0, 0);

  const rawCholiBody = computeBodyAnchors(keypoints, 'hip', config);
  if (!rawCholiBody) return 'pose-not-anchorable';
  const rawSkirtBody = computeLehengaSkirtBodyAnchors(keypoints, skirtLength, config);
  if (!rawSkirtBody) return 'pose-not-anchorable';
  const foreshorten = input.foreshortenFactor ?? 1;
  const choliBody = foreshortenAnchors(rawCholiBody, foreshorten);
  const skirtBody = foreshortenAnchors(rawSkirtBody, foreshorten);

  const choliSrc: Point[] = ANCHOR_NAMES.map((n) => choliAnchors[n]);
  const choliDst: Point[] = ANCHOR_NAMES.map((n) => choliBody[n]);
  const skirtSrc: Point[] = SKIRT_ANCHOR_NAMES.map((n) => lehengaAnchors[n]);
  const skirtDst: Point[] = SKIRT_ANCHOR_NAMES.map((n) => skirtBody[n]);

  const lehengaLayer = renderGarmentWarp(lehengaImage, skirtSrc, skirtDst, w, h, warpGrid);
  const choliLayer = renderGarmentWarp(choliImage, choliSrc, choliDst, w, h, warpGrid);

  let shadedLehengaLayer = lehengaLayer;
  let shadedCholiLayer = choliLayer;
  if (input.choliNormal || input.lehengaNormal) {
    const light = estimateLight(frame, maskBitmap, w, h, config.relighting);
    if (input.choliNormal) {
      const choliNormalLayer = renderGarmentWarp(input.choliNormal, choliSrc, choliDst, w, h, warpGrid);
      const bbox = toPixelBBox(expandedAnchorBBox(choliBody, config.relighting.bboxMarginFrac, w, h));
      shadedCholiLayer = applyGarmentShading(
        choliLayer,
        choliNormalLayer,
        light,
        bbox,
        w,
        h,
        config.relighting,
        input.personDepth,
      );
    }
    if (input.lehengaNormal) {
      const lehengaNormalLayer = renderGarmentWarp(input.lehengaNormal, skirtSrc, skirtDst, w, h, warpGrid);
      const skirtBox = expandBBox(
        bboxOfPoints(SKIRT_ANCHOR_NAMES.map((n) => skirtBody[n])),
        config.relighting.bboxMarginFrac,
        w,
        h,
      );
      shadedLehengaLayer = applyGarmentShading(
        lehengaLayer,
        lehengaNormalLayer,
        light,
        toPixelBBox(skirtBox),
        w,
        h,
        config.relighting,
        input.personDepth,
      );
    }
  }

  const combined = new OffscreenCanvas(w, h);
  const combinedCtx = combined.getContext('2d');
  if (!combinedCtx) throw new Error('renderLehengaCholiTryOn: no 2d context');
  combinedCtx.drawImage(shadedLehengaLayer, 0, 0);
  combinedCtx.drawImage(shadedCholiLayer, 0, 0);

  const feathered = renderFeatheredMask(maskBitmap, w, h);
  // The skirt hangs free below its waistband — open the clip there so it
  // drapes over the background and the gap between legs, instead of being
  // shrink-wrapped to the leg silhouette. The choli above stays mask-clipped.
  const skirtWaistY = (skirtBody.waistL[1] + skirtBody.waistR[1]) / 2;
  const skirtHemY = (skirtBody.hemL[1] + skirtBody.hemR[1]) / 2;
  const skirtLen = skirtHemY - skirtWaistY;
  const clipMask = openMaskBelow(
    feathered,
    skirtWaistY,
    skirtLen * 0.15,
    skirtHemY + skirtLen * 0.03,
    skirtLen * 0.05,
  );
  const clipped = clipToMask(combined, w, h, clipMask);
  ctx.save();
  ctx.globalAlpha = input.viewAlpha ?? 1;
  ctx.drawImage(clipped, 0, 0);
  ctx.restore();

  if (input.armOcclusion !== false) {
    if (input.personDepth) {
      applyDepthOcclusion(ctx, frame, input.personDepth, keypoints, choliBody, w, h, config);
    } else {
      drawArmOcclusion(ctx, frame, keypoints, choliBody, input.armOcclusionRadiusFactor ?? config.armOcclusionRadiusFactor);
    }
  }

  return 'ok';
}

export interface PantsTryOnInput {
  frame: ImageBitmap;
  maskBitmap: ImageBitmap;
  keypoints: readonly Keypoint[];
  garmentImage: CanvasImageSource & { width: number; height: number };
  /** Waistband corners + per-leg outer hem corners in garment-image pixels (same shape as a lehenga skirt's anchors — see computePantsBodyAnchors for how the hem semantics differ). */
  garmentAnchors: SkirtAnchors;
  /** knee = shorts, ankle = full-length. */
  hemLength: HemLength;
  warpGrid?: WarpGridOptions;
  personDepth?: DepthMapSource | null;
  /** Advanced-mode normal map (Phase A3), same pixel space/coverage as `garmentImage`. */
  garmentNormal?: (CanvasImageSource & { width: number; height: number }) | null;
  /** See TryOnInput.foreshortenFactor (Phase A5). */
  foreshortenFactor?: number;
  /** See TryOnInput.viewAlpha (Phase A5). */
  viewAlpha?: number;
  /** See TryOnInput.config. */
  config?: PartialTryOnConfig;
}

/**
 * Try-on render for pants/shorts (lower-body, leg-tracking garment). Unlike
 * a skirt there is no open-clip below the waist: pants are FITTED, so the
 * warped fabric is clipped to the person mask everywhere — that is what
 * keeps the gap between the legs open and snaps the (anchor-less) inner-leg
 * fabric edges to the leg silhouette. The wearer's own top half is
 * untouched — pants only paint below their waistband targets.
 *
 * No arm/hand occlusion pass: the capsule heuristic and the depth-occlusion
 * scan are both parameterized around torso/shoulder anchors that a pants
 * anchor set doesn't have. Hands hanging in front of thighs are covered by
 * fabric — a visible but rare artifact, revisit if it bothers in practice.
 */
export function renderPantsTryOn(ctx: Canvas2DContext, input: PantsTryOnInput): TryOnStatus {
  return renderOutfitTryOn(ctx, {
    frame: input.frame,
    maskBitmap: input.maskBitmap,
    keypoints: input.keypoints,
    pants: {
      image: input.garmentImage,
      anchors: input.garmentAnchors,
      hemLength: input.hemLength,
      normal: input.garmentNormal,
    },
    warpGrid: input.warpGrid,
    personDepth: input.personDepth,
    foreshortenFactor: input.foreshortenFactor,
    viewAlpha: input.viewAlpha,
    config: input.config,
  });
}

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

/** Bounding box of a set of points. */
function bboxOfPoints(points: readonly Point[]): BBox {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** `box` expanded by a fraction of its own size and clamped to (maxW, maxH). */
function expandBBox(box: BBox, marginFrac: number, maxW: number, maxH: number): BBox {
  const mx = (box.maxX - box.minX) * marginFrac;
  const my = (box.maxY - box.minY) * marginFrac;
  return {
    minX: Math.max(0, box.minX - mx),
    minY: Math.max(0, box.minY - my),
    maxX: Math.min(maxW, box.maxX + mx),
    maxY: Math.min(maxH, box.maxY + my),
  };
}

/** Rounds a BBox out to integer pixel bounds for canvas getImageData/patch operations. */
function toPixelBBox(box: BBox): ShadingBBox {
  const bx = Math.floor(box.minX);
  const by = Math.floor(box.minY);
  return { bx, by, bw: Math.ceil(box.maxX) - bx, bh: Math.ceil(box.maxY) - by };
}

/** Bounding box of the garment's body-space anchors — a proxy for "where the fabric is". */
function anchorBBox(anchors: GarmentAnchors): BBox {
  return bboxOfPoints(ANCHOR_NAMES.map((n) => anchors[n]));
}

function overlapsBBox(x: number, y: number, box: BBox): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}

/** anchorBBox expanded by a fraction of its own size and clamped to the frame — hands, hair, and held objects typically extend past the torso anchors themselves. */
function expandedAnchorBBox(anchors: GarmentAnchors, marginFrac: number, maxW: number, maxH: number): BBox {
  return expandBBox(anchorBBox(anchors), marginFrac, maxW, maxH);
}

/**
 * Separable box blur of an ImageData's R channel (grayscale depth map),
 * returned as a plain w*h array of blurred values. O(w*h) regardless of
 * radius via a running-sum sliding window, not O(w*h*radius^2).
 */
function boxBlurRedChannel(data: Uint8ClampedArray, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) {
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = data[i * 4];
    return out;
  }

  const tmp = new Float32Array(w * h);
  const size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += data[(y * w + Math.min(w - 1, Math.max(0, x))) * 4];
    }
    tmp[y * w] = sum / size;
    for (let x = 1; x < w; x++) {
      const addX = Math.min(w - 1, x + radius);
      const subX = Math.max(0, x - radius - 1);
      sum += data[(y * w + addX) * 4] - data[(y * w + subX) * 4];
      tmp[y * w + x] = sum / size;
    }
  }

  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    }
    out[x] = sum / size;
    for (let y = 1; y < h; y++) {
      const addY = Math.min(h - 1, y + radius);
      const subY = Math.max(0, y - radius - 1);
      sum += tmp[addY * w + x] - tmp[subY * w + x];
      out[y * w + x] = sum / size;
    }
  }
  return out;
}

/**
 * Depth-tested occlusion (Phase A2 — used whenever an advanced-mode person
 * depth map is available): restores original frame pixels anywhere the
 * person is measurably closer to the camera than the garment's own
 * surface, so arms, hair, and held objects occlude the fabric correctly
 * wherever they actually are in the photo — not just along the forearm
 * segment the arm-capsule fallback special-cases.
 *
 * The garment has no real depth geometry, so its "surface" is approximated
 * as a smooth field interpolated — via the same TPS math the warp itself
 * uses, just with a scalar (depth) target instead of a 2D point — from the
 * person's own measured depth at each body anchor: the torso's actual
 * depth stands in for "roughly where the fabric sits".
 *
 * The scan region is bounded below at the hip line (plus a short margin,
 * config.depthOcclusion.belowHipCutoffFrac) regardless of how far the
 * garment itself hangs — legs are always under the skirt, never in front
 * of it, and depth reads a forward leg as an occluder.
 */
function applyDepthOcclusion(
  ctx: Canvas2DContext,
  frame: ImageBitmap,
  personDepth: DepthMapSource,
  keypoints: readonly Keypoint[],
  bodyAnchors: GarmentAnchors,
  w: number,
  h: number,
  config: TryOnConfig,
): void {
  // The reference "garment surface depth" below needs confidently-placed
  // torso keypoints, and so does the leg cutoff — gate on them up front.
  const byName = new Map(keypoints.map((k) => [k.name, k] as const));
  const shoulderL = byName.get('left_shoulder');
  const shoulderR = byName.get('right_shoulder');
  const hipL = byName.get('left_hip');
  const hipR = byName.get('right_hip');
  const minScore = config.minKeypointScore;
  if (
    !shoulderL || !shoulderR || !hipL || !hipR ||
    shoulderL.score < minScore || shoulderR.score < minScore ||
    hipL.score < minScore || hipR.score < minScore
  ) {
    return; // torso not confidently visible; skip occlusion this frame.
  }

  // Legs are always *under* the garment being worn, never in front of it —
  // but a knee/ankle garment's anchors reach its hem, and monocular depth
  // routinely reads a forward leg as "closer than the torso" (a real local
  // reading, not noise the blur below can remove), which carved leg-shaped
  // holes out of long skirts. Everything that genuinely occludes worn
  // fabric (arms, hair, held objects) operates at or above hip level, so
  // the scan simply never descends more than a short margin past the hips.
  const hipMidY = (hipL.y + hipR.y) / 2;
  const shoulderMidY = (shoulderL.y + shoulderR.y) / 2;
  const torsoHeight = Math.abs(hipMidY - shoulderMidY);
  const legCutoffY = hipMidY + torsoHeight * config.depthOcclusion.belowHipCutoffFrac;

  const scanBox = expandedAnchorBBox(bodyAnchors, config.depthOcclusion.bboxMarginFrac, w, h);
  const { bx, by, bw, bh } = toPixelBBox({ ...scanBox, maxY: Math.min(scanBox.maxY, legCutoffY) });
  if (bw <= 0 || bh <= 0) return;

  const depthCanvas = new OffscreenCanvas(w, h);
  const depthCtx = depthCanvas.getContext('2d');
  if (!depthCtx) return;
  depthCtx.drawImage(personDepth, 0, 0, w, h);
  const rawDepthData = depthCtx.getImageData(bx, by, bw, bh).data;
  // Monocular depth estimation isn't just noisy at fine scale — it actively
  // misjudges high-contrast printed/patterned fabric as height variation
  // (a well-known failure mode: bright/dark regions of a print get read as
  // near/far). Left unblurred, that noise crosses the occlusion threshold
  // the same way a real arm-in-front discontinuity does, "revealing" the
  // person's real shirt in the exact shape of its own print. A real
  // occluding object (arm, hair, held item) is a broad, low-frequency
  // depth shift; print-induced noise is high-frequency. Blur suppresses
  // the latter while leaving the former intact.
  const blurRadius = config.depthOcclusion.blurRadiusPx;
  const depthField2D = boxBlurRedChannel(rawDepthData, bw, bh, blurRadius);

  const depthAt = (x: number, y: number): number => {
    const cx = Math.min(bw - 1, Math.max(0, Math.round(x - bx)));
    const cy = Math.min(bh - 1, Math.max(0, Math.round(y - by)));
    return depthField2D[cy * bw + cx];
  };

  // The reference "garment surface depth" must come from real on-body
  // locations. The garment anchor targets (bodyAnchors) are deliberately
  // widened past the body's own edge for fit (see config.anchors.
  // widthScale) — sampling depth there can land in the background. The
  // raw pose keypoints (shoulders/hips) are guaranteed on the body, but a
  // reference built from just those 4 sparse points (a TPS fit through
  // them) is fragile: a single anomalous sample — e.g. a shoulder keypoint
  // landing exactly on a strap or shadow edge, which happens even after
  // blurring, since it's a real local depth feature at that point, not
  // noise — drags the whole *smoothly interpolated* surface down across a
  // wide area, since TPS is a global fit, not a local one. A single
  // person's real hand-on-hip photo showed exactly this: one shoulder
  // sample ~40 gray levels below the other three was enough to falsely
  // "occlude" a large fraction of the torso. Sampling densely across the
  // torso interior (bilinear grid between the 4 keypoints) and taking a
  // robust order statistic is safe against that: one bad sample among
  // dozens barely moves it.
  const torsoSamples: number[] = [];
  const GRID = 5;
  for (let iv = 1; iv < GRID; iv++) {
    const v = iv / GRID;
    for (let iu = 1; iu < GRID; iu++) {
      const u = iu / GRID;
      const topPt: Point = [shoulderL.x + (shoulderR.x - shoulderL.x) * u, shoulderL.y + (shoulderR.y - shoulderL.y) * u];
      const botPt: Point = [hipL.x + (hipR.x - hipL.x) * u, hipL.y + (hipR.y - hipL.y) * u];
      const x = topPt[0] + (botPt[0] - topPt[0]) * v;
      const y = topPt[1] + (botPt[1] - topPt[1]) * v;
      torsoSamples.push(depthAt(x, y));
    }
  }
  // The reference is a HIGH percentile of those samples, not the median:
  // fabric drapes over the torso's front-most surface (chest, belly), so
  // "where the garment sits" is the near side of the torso's own depth
  // spread. With the median, anything that protrudes — a belly, most
  // visibly — reads as measurably closer than the reference and gets
  // "restored" over the fabric, punching a torso-shaped hole in the
  // garment. A percentile below 1.0 keeps the outlier robustness the
  // median was originally chosen for (a stray sample, e.g. an arm crossing
  // the torso mid-sample, must not become the reference the way a max
  // would let it).
  torsoSamples.sort((a, b) => a - b);
  const refIndex = Math.min(
    torsoSamples.length - 1,
    Math.floor(torsoSamples.length * config.depthOcclusion.referencePercentile),
  );
  const garmentVal = torsoSamples[refIndex];

  const { marginGray, softBandGray } = config.depthOcclusion;
  const maskData = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const personVal = depthField2D[y * bw + x];
      // Soft threshold: fully occluded well past the margin, fully fabric
      // well before it, a smooth ramp across the band between.
      const t = (personVal - (garmentVal + marginGray)) / softBandGray;
      const alpha = Math.max(0, Math.min(1, t));
      const i = (y * bw + x) * 4;
      maskData[i] = 255;
      maskData[i + 1] = 255;
      maskData[i + 2] = 255;
      maskData[i + 3] = Math.round(alpha * 255);
    }
  }

  const maskCanvas = new OffscreenCanvas(bw, bh);
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;
  maskCtx.putImageData(new ImageData(maskData, bw, bh), 0, 0);

  const framePatch = new OffscreenCanvas(bw, bh);
  const framePatchCtx = framePatch.getContext('2d');
  if (!framePatchCtx) return;
  framePatchCtx.drawImage(frame, bx, by, bw, bh, 0, 0, bw, bh);

  const clippedPatch = clipToMask(framePatch, bw, bh, maskCanvas);
  ctx.drawImage(clippedPatch, bx, by);
}

/**
 * Restores original frame pixels along each forearm (elbow→wrist, extended
 * slightly past the wrist for the hand) when that arm crosses the garment's
 * bounding box — an approximation of correct depth ordering without a real
 * depth/segmentation-per-limb signal. Fallback path used when no
 * advanced-mode depth map is available (see applyDepthOcclusion above).
 */
function drawArmOcclusion(
  ctx: Canvas2DContext,
  frame: ImageBitmap,
  keypoints: readonly Keypoint[],
  bodyAnchors: GarmentAnchors,
  radiusFactor: number,
): void {
  const box = anchorBBox(bodyAnchors);
  const [slx, sly] = bodyAnchors.shoulderL;
  const [srx, sry] = bodyAnchors.shoulderR;
  const shoulderWidth = Math.hypot(srx - slx, sry - sly);
  const radius = Math.max(2, shoulderWidth * radiusFactor);

  const byName = new Map(keypoints.map((k) => [k.name, k] as const));
  const minScore = 0.3;

  for (const [elbowName, wristName] of [
    ['left_elbow', 'left_wrist'],
    ['right_elbow', 'right_wrist'],
  ] as const) {
    const elbow = byName.get(elbowName);
    const wrist = byName.get(wristName);
    if (!elbow || !wrist || elbow.score < minScore || wrist.score < minScore) continue;
    if (!overlapsBBox(elbow.x, elbow.y, box) && !overlapsBBox(wrist.x, wrist.y, box)) continue;

    // Extend a bit past the wrist to cover the hand.
    const dx = wrist.x - elbow.x;
    const dy = wrist.y - elbow.y;
    const ex = wrist.x + dx * 0.35;
    const ey = wrist.y + dy * 0.35;

    ctx.save();
    capsulePath(ctx, elbow.x, elbow.y, ex, ey, radius);
    ctx.clip();
    ctx.drawImage(frame, 0, 0);
    ctx.restore();
  }
}

/** Builds a stadium/capsule-shaped clip path along the segment (x1,y1)-(x2,y2). */
function capsulePath(
  ctx: Canvas2DContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * r;
  const ny = (dx / len) * r;
  const angle = Math.atan2(dy, dx);

  ctx.beginPath();
  ctx.moveTo(x1 + nx, y1 + ny);
  ctx.lineTo(x2 + nx, y2 + ny);
  ctx.arc(x2, y2, r, angle - Math.PI / 2, angle + Math.PI / 2);
  ctx.lineTo(x1 - nx, y1 - ny);
  ctx.arc(x1, y1, r, angle + Math.PI / 2, angle + Math.PI * 1.5);
  ctx.closePath();
}
