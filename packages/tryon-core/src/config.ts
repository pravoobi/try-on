/**
 * Every tunable this package's own functions need, with the exact default
 * values the reference app (pravoobi/try-on) ships. Each pipeline function
 * that needs tuning takes it as an explicit parameter — nothing in this
 * package reaches into a global/singleton config — so an embedding app can
 * override any subset of these (see `resolveTryOnConfig`) without touching
 * this package's source. Import `DEFAULT_CONFIG` (or its individual
 * sections) directly if you're happy with the defaults.
 */
import type { GarmentExtractOptions } from './garmentExtract.js';
import type { SwipeConfig } from './gesture.js';
import type { OrientationConfig } from './orientation.js';
import type { HemLength } from './types.js';
import type { WarpGridOptions } from 'thin-plate-spline';

export interface AnchorConfig {
  /** MoveNet keypoints sit at skeletal joints, inside the visual body silhouette — garment anchor targets are widened outward from the joint pair's midpoint so fabric reaches the body's edges. Overflow past the silhouette is clipped to the person mask, so err wide. */
  widthScale: { shoulder: number; hip: number };
  /** Raise shoulder targets by this fraction of torso height — garment shoulder seams sit on top of the shoulder, the keypoint at the joint center below it. */
  shoulderLift: number;
  /** Fraction of the way from shoulder to hip where the waist anchor sits. */
  waistT: number;
  /** Hem placement when the knee/ankle keypoint is missing or unconfident: hem_y = hip_y + torsoHeight * multiplier, per meta.length. */
  hemFallbackMultiplier: Record<HemLength, number>;
  /** Lehenga skirt hem half-width, as a multiple of the hip half-width — a flared skirt's hem is meant to be much wider than its waistband, unlike a fitted dress hem which hangs straight down at hip width. */
  skirtFlare: Record<HemLength, number>;
  /** Single-piece garment hem flare, same units as skirtFlare but far subtler: a hem pinned to exactly hip width leaves a wide-stance leg poking out beside the fabric on knee/ankle dresses. Hip-length garments stay fitted (1). */
  dressFlare: Record<HemLength, number>;
  /** Extra hem width past the outermost leg keypoint, as a fraction of the (widened) hip half-width. */
  stanceCoverMargin: number;
  /** Confidence band (above minKeypointScore) over which a leg joint's stance-cover constraint fades in, instead of popping the hem width at a hard threshold. */
  stanceScoreSoftBand: number;
}

export interface RelightingConfig {
  /** Shading-pass scan bbox margin, as a fraction of the anchor bbox. */
  bboxMarginFrac: number;
  /** How much a 1px depth-map height delta tilts the derived normal — higher = more visible fabric texture from the garment's own depth map. */
  normalStrength: number;
  /** Baseline light every garment pixel gets regardless of orientation, so shaded areas never go pure black. */
  ambient: number;
  /** How strongly the person photo's average brightness gradient tilts the estimated light direction off frontal. */
  gradientGain: number;
  /** Z-component bias for the estimated light before normalizing — portrait photos are usually front-lit. */
  frontalBias: number;
  /** Overall shading multiplier range, driven by the photo's mean luminance. */
  minIntensity: number;
  maxIntensity: number;
  /** Clamp on the final per-pixel shade factor, so no pixel goes fully black or blown out. */
  minShade: number;
  maxShade: number;
  /** Screen-space AO from person-depth edges (body curving away from camera). */
  aoGain: number;
  aoMax: number;
}

export interface DepthOcclusionConfig {
  /** Scan bbox margin, as a fraction of the anchor bbox size — hands/hair typically extend past the torso anchors themselves. */
  bboxMarginFrac: number;
  /** Box-blur radius (px) applied to the person depth map before the occlusion compare — suppresses high-frequency print-induced depth noise while leaving real (broad, low-frequency) occluders intact. */
  blurRadiusPx: number;
  /** Which percentile of the torso depth samples stands in for the garment's surface — a high percentile since fabric drapes over the torso's front-most surface. */
  referencePercentile: number;
  /** Gray-level tolerance before a person pixel counts as "in front of" the garment (0-255 scale). */
  marginGray: number;
  /** Width, in gray levels, of the soft occlusion edge ramp. */
  softBandGray: number;
  /** The occlusion scan never descends more than this fraction of torso height below the hip line — legs are always under worn fabric, never in front of it. */
  belowHipCutoffFrac: number;
}

export interface TryOnConfig {
  /** Keypoints below this score are not used for anchoring. */
  minKeypointScore: number;
  anchors: AnchorConfig;
  relighting: RelightingConfig;
  depthOcclusion: DepthOcclusionConfig;
  /** TPS warp evaluation grid. */
  warpGrid: WarpGridOptions;
  /** Arm-occlusion capsule radius, as a fraction of shoulder-to-shoulder width — fallback path used when no depth map is available. */
  armOcclusionRadiusFactor: number;
}

export const DEFAULT_CONFIG: TryOnConfig = {
  minKeypointScore: 0.3,
  anchors: {
    widthScale: { shoulder: 1.15, hip: 1.45 },
    shoulderLift: 0.05,
    waistT: 0.62,
    hemFallbackMultiplier: { hip: 0.15, knee: 1.0, ankle: 1.9 },
    skirtFlare: { hip: 1, knee: 1.9, ankle: 2.6 },
    dressFlare: { hip: 1, knee: 1.2, ankle: 1.35 },
    stanceCoverMargin: 0.25,
    stanceScoreSoftBand: 0.15,
  },
  relighting: {
    bboxMarginFrac: 0.15,
    normalStrength: 0.12,
    ambient: 0.55,
    gradientGain: 0.05,
    frontalBias: 1.2,
    minIntensity: 0.7,
    maxIntensity: 1.3,
    minShade: 0.35,
    maxShade: 1.15,
    aoGain: 0.6,
    aoMax: 0.5,
  },
  depthOcclusion: {
    bboxMarginFrac: 0.5,
    blurRadiusPx: 18,
    referencePercentile: 0.85,
    marginGray: 10,
    softBandGray: 18,
    belowHipCutoffFrac: 0.2,
  },
  warpGrid: { cols: 16, rows: 24 },
  armOcclusionRadiusFactor: 0.14,
};

export interface PartialTryOnConfig {
  minKeypointScore?: number;
  anchors?: Partial<AnchorConfig>;
  relighting?: Partial<RelightingConfig>;
  depthOcclusion?: Partial<DepthOcclusionConfig>;
  warpGrid?: WarpGridOptions;
  armOcclusionRadiusFactor?: number;
}

/** Merges a partial override (any subset of any section) onto DEFAULT_CONFIG. Every renderTryOn/renderLehengaCholiTryOn call resolves its `config` field through this, so omitting it entirely reproduces the reference app's behavior exactly. */
export function resolveTryOnConfig(partial?: PartialTryOnConfig): TryOnConfig {
  return {
    minKeypointScore: partial?.minKeypointScore ?? DEFAULT_CONFIG.minKeypointScore,
    anchors: { ...DEFAULT_CONFIG.anchors, ...partial?.anchors },
    relighting: { ...DEFAULT_CONFIG.relighting, ...partial?.relighting },
    depthOcclusion: { ...DEFAULT_CONFIG.depthOcclusion, ...partial?.depthOcclusion },
    warpGrid: partial?.warpGrid ?? DEFAULT_CONFIG.warpGrid,
    armOcclusionRadiusFactor: partial?.armOcclusionRadiusFactor ?? DEFAULT_CONFIG.armOcclusionRadiusFactor,
  };
}

/** Default for gesture.ts's `updateSwipeDetection` — matches the reference app's live-mode gesture tuning. Gesture config is a self-contained, independent concern (garment swipe / photo-capture trigger), so it's exported separately rather than folded into TryOnConfig. */
export const DEFAULT_GESTURE_CONFIG: SwipeConfig = {
  minTravelFrac: 0.22,
  windowMs: 700,
  minSamples: 5,
  cooldownMs: 900,
  minKeypointScore: 0.3,
  verticalDominanceMargin: 1.3,
};

/** Default for orientation.ts's live-mode orientation-aware warp + view selection. Independent of TryOnConfig for the same reason as DEFAULT_GESTURE_CONFIG. */
export const DEFAULT_ORIENTATION_CONFIG: OrientationConfig = {
  frontMaxYawDeg: 35,
  backMinYawDeg: 145,
  faceVisibleThreshold: 0.25,
  calibrationDecay: 0.995,
  calibrationGrowthAlpha: 0.25,
  yawSmoothingAlpha: 0.3,
  foreshortenDeadbandDeg: 12,
  minKeypointScore: 0.3,
  minViewAlpha: 0.08,
  fadeRampDeg: 20,
  foreshortenFloor: 0.22,
};

/** Default for matting.worker.ts / garmentExtract.ts's worn-garment extraction (see extractGarmentAlpha's own docs for what each field means). */
export const DEFAULT_GARMENT_EXTRACT_CONFIG: GarmentExtractOptions = {
  humanPresenceFrac: 0.05,
  minGarmentFrac: 0.05,
  maskBlurPx: 2,
};

/** Exponential smoothing factor for live keypoints: s = α·new + (1−α)·prev (see smoothing.ts). Lower = steadier. */
export const DEFAULT_SMOOTHING_ALPHA = 0.3;
