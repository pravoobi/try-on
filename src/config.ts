/** All tunables and paths live here (see CLAUDE.md conventions). */
export const config = {
  models: {
    // Square general model: best person resolution on portrait photos.
    // Swap to selfie_segmenter_landscape.tflite (256×144) for live landscape
    // webcam frames in Phase 3.
    segmenter: '/models/selfie_segmenter.tflite',
    pose: '/models/movenet_singlepose_lightning.tflite',
  },
  /** Directory the LiteRT.js Wasm runtime is served from (vite-plugin-static-copy). */
  litertWasmPath: '/litert-wasm/',
  /** Keypoints below this score are not drawn / not used for anchoring. */
  minKeypointScore: 0.3,
  /** Exponential smoothing factor for live keypoints (Phase 3): s = α·new + (1−α)·prev. Lower = steadier; keypoint noise propagates into anchor targets, hem stance cover, and the yaw estimate, all of which read as the garment "shaking" on a still subject. */
  smoothingAlpha: 0.3,
  /** Live inference throttle target (Phase 3). */
  targetFps: 15,
  /**
   * Webcam capture resolution cap (ideal, not exact — the browser picks
   * the nearest supported mode). Every per-pixel pass downstream (TPS
   * warp, mask feather/clip, shading, depth occlusion) scales with frame
   * area, so an uncapped HD capture makes live mode 3-4x slower for no
   * visible benefit at preview sizes.
   */
  webcam: { idealWidth: 640, idealHeight: 480 },
  /** Debug overlay: mask tint opacity. */
  maskOpacity: 0.45,
  /** Quick-load test photos served from /test-photos/ (fetched by npm run fetch-test-photos). */
  testPhotos: [
    'photo-01.jpg',
    'photo-02.jpg',
    'photo-03.jpg',
    'photo-04.jpg',
    'photo-05.jpg',
  ],
  anchors: {
    /**
     * MoveNet keypoints sit at skeletal joints, inside the visual body
     * silhouette — garment anchor targets are widened outward from the
     * joint pair's midpoint so fabric reaches the body's edges. Overflow
     * past the silhouette is clipped to the person mask, so err wide.
     */
    widthScale: { shoulder: 1.15, hip: 1.45 },
    /**
     * Raise shoulder targets by this fraction of torso height — garment
     * shoulder seams sit on top of the shoulder, the keypoint at the joint
     * center below it.
     */
    shoulderLift: 0.05,
    /** Fraction of the way from shoulder to hip where the waist anchor sits. */
    waistT: 0.62,
    /**
     * Hem placement when the knee/ankle keypoint is missing or unconfident:
     * hem_y = hip_y + torsoHeight * multiplier, per meta.length.
     */
    hemFallbackMultiplier: { hip: 0.15, knee: 1.0, ankle: 1.9 },
    /**
     * Lehenga skirt hem half-width, as a multiple of the hip half-width — a
     * flared skirt's hem is meant to be much wider than its waistband, unlike
     * a fitted dress hem which hangs straight down at hip width (see
     * anchorMapping.ts computeFlaredHem).
     */
    skirtFlare: { hip: 1, knee: 1.9, ankle: 2.6 },
    /**
     * Single-piece garment hem flare, same units as skirtFlare but far
     * subtler: a hem pinned to exactly hip width leaves a wide-stance leg
     * poking out beside the fabric on knee/ankle dresses, while a real
     * dress hem hangs a bit wider than the hips. Hip-length garments stay
     * fitted (1) — their hem is at the hips by definition.
     */
    dressFlare: { hip: 1, knee: 1.2, ankle: 1.35 },
    /**
     * Extra hem width past the outermost leg keypoint, as a fraction of the
     * (widened) hip half-width — keypoints sit at joint centers, so the
     * fabric needs to clear the leg's own outer edge too (see
     * anchorMapping.ts computeFlaredHem's stance cover).
     */
    stanceCoverMargin: 0.25,
    /**
     * Confidence band (above minKeypointScore) over which a leg joint's
     * stance-cover constraint fades in. A hard threshold makes the hem
     * width JUMP whenever a knee/ankle score hovers around the cutoff —
     * visible as the skirt silhouette popping frame to frame in live mode.
     */
    stanceScoreSoftBand: 0.15,
  },
  /** TPS warp evaluation grid (see pipeline/warp.ts). */
  warpGrid: { cols: 16, rows: 24 },
  /** Arm-occlusion capsule radius, as a fraction of shoulder-to-shoulder width — fallback path used when no advanced-mode depth map is available (see compositor.ts). */
  armOcclusionRadiusFactor: 0.14,
  /**
   * Depth-tested occlusion (Phase A2, advanced mode only): a garment has no
   * real depth geometry, so its "surface" is approximated as a field
   * interpolated from the person's own measured depth at each body anchor.
   * A person pixel occludes the garment where its depth exceeds that
   * surface by more than marginGray, ramping smoothly over softBandGray.
   */
  depthOcclusion: {
    /** Scan bbox margin, as a fraction of the anchor bbox size — hands/hair typically extend past the torso anchors themselves. */
    bboxMarginFrac: 0.5,
    /**
     * Box-blur radius (px) applied to the person depth map before the
     * occlusion compare. Monocular depth estimation misjudges high-contrast
     * printed/patterned fabric as height variation — a real occluding
     * object (arm, hair, held item) is a broad, low-frequency depth shift,
     * while print-induced noise is high-frequency; blurring suppresses the
     * latter without erasing the former. Set to 0 to disable (raw per-pixel
     * compare — will misfire on printed garments/clothing, see
     * docs/plan-3d-garment-assets.md Phase A2 notes).
     */
    blurRadiusPx: 18,
    /**
     * Which percentile of the torso depth samples stands in for the
     * garment's surface. Fabric drapes over the torso's *front-most*
     * surface (chest, belly), so this must sit near the top of the torso's
     * own depth spread — with the median, anything that protrudes (a
     * belly) reads as "in front of the garment" and punches a hole in the
     * fabric. Below 1.0 for robustness against a stray sample (an arm
     * crossing the torso during sampling shouldn't become the reference).
     */
    referencePercentile: 0.85,
    /** Gray-level tolerance before a person pixel counts as "in front of" the garment (0-255 scale). */
    marginGray: 10,
    /** Width, in gray levels, of the soft occlusion edge ramp. */
    softBandGray: 18,
    /**
     * The occlusion scan never descends more than this fraction of torso
     * height below the hip line. Legs are always *under* the garment being
     * worn, never in front of it, but monocular depth reads a forward leg
     * as "closer than the torso" — scanning down a knee/ankle garment's
     * full extent carved leg-shaped holes out of the skirt. Everything
     * that genuinely occludes worn fabric (arms, hair, held objects)
     * operates at or above hip level; hands-on-hips stay inside the scan.
     */
    belowHipCutoffFrac: 0.2,
  },
  /**
   * Single-light Lambertian relighting (Phase A3, advanced mode only): see
   * pipeline/relight.ts. Shades a flat garment photo against a light
   * direction estimated from the person's own photo, using a normal map
   * derived from the garment's own depth map (pipeline/normalMap.ts).
   */
  relighting: {
    /** Shading-pass scan bbox margin, as a fraction of the anchor bbox — the garment's own rendered area doesn't reach as far past its anchors as arms/hair do (compare depthOcclusion.bboxMarginFrac). */
    bboxMarginFrac: 0.15,
    /** How much a 1px depth-map height delta tilts the derived normal — higher = more visible fabric texture from the garment's own depth map. */
    normalStrength: 0.12,
    /** Baseline light every garment pixel gets regardless of orientation, so shaded areas never go pure black. */
    ambient: 0.55,
    /** How strongly the person photo's average brightness gradient tilts the estimated light direction off frontal. */
    gradientGain: 0.05,
    /** Z-component bias for the estimated light before normalizing — portrait photos are usually front-lit; keeps shading plausible even when the gradient signal is weak/noisy. */
    frontalBias: 1.2,
    /** Overall shading multiplier range, driven by the photo's mean luminance. */
    minIntensity: 0.7,
    maxIntensity: 1.3,
    /** Clamp on the final per-pixel shade factor, so no pixel goes fully black or blown out. */
    minShade: 0.35,
    maxShade: 1.15,
    /** Screen-space AO from person-depth edges (body curving away from camera). */
    aoGain: 0.6,
    aoMax: 0.5,
  },
  /**
   * Orientation-aware warp + view selection (Phase A5, live mode only — a
   * single photo has no baseline to compare against, see pipeline/
   * orientation.ts). MoveNet has no z, so yaw is a 2D-only heuristic (the
   * plan's own sanctioned interim): shoulder width relative to a running
   * "most-frontal-observed" calibration, disambiguated near 180° by
   * nose/eye visibility dropping out.
   */
  orientation: {
    /** |yaw| at/below this = front view (full garment, no fade). */
    frontMaxYawDeg: 35,
    /** |yaw| at/above this = back view (only if the asset has a back photo). */
    backMinYawDeg: 145,
    /** Average nose/eye keypoint confidence below this = face not visible (the back-facing signal). */
    faceVisibleThreshold: 0.25,
    /** Per-tick decay on the running frontal shoulder-width baseline when not actively growing — lets a stale high-water-mark (e.g. leaning in early in the session) relax over time. */
    calibrationDecay: 0.995,
    /**
     * How fast the baseline approaches a wider confidently-frontal
     * observation (EMA, not a jump): a single glitchy wide frame must not
     * become the baseline — yaw is measured against it, so a poisoned
     * baseline reads a normal stance as "turned", permanently half-fading
     * the garment (seen in the field as the dress looking transparent).
     */
    calibrationGrowthAlpha: 0.25,
    /**
     * EMA smoothing on the yaw estimate itself (hooks/useTorsoOrientation).
     * acos(width/baseline) has unbounded slope near frontal, so a couple
     * of pixels of shoulder-keypoint noise swings raw yaw by tens of
     * degrees — enough to flicker across the fade threshold and read as
     * the garment blinking on a perfectly still subject.
     */
    yawSmoothingAlpha: 0.3,
    /**
     * No foreshortening within this many degrees of dead-front/dead-back —
     * residual yaw noise otherwise makes the garment's width "breathe"
     * frame to frame while the subject stands still.
     */
    foreshortenDeadbandDeg: 12,
    /** Shoulder-keypoint confidence required to attempt orientation estimation at all. */
    minKeypointScore: 0.3,
    /** Garment layer opacity floor in the unrenderable profile band — never fully invisible, so the fade reads as "turn", not "vanished". */
    minViewAlpha: 0.08,
    /** Degrees of smoothstep ramp on either side of the front/back thresholds. */
    fadeRampDeg: 20,
    /** Floor on the horizontal foreshorten scale factor — never collapse the garment to a sliver, which would degenerate the TPS warp. */
    foreshortenFloor: 0.22,
  },
  /**
   * Throttled live-mode person depth (Phase A5, see
   * docs/plan-3d-garment-assets.md §5.5): depth inference is too slow to run
   * every pose-tick even on WebGPU (~100-300ms, A1 notes), so it runs on its
   * own slower timer against a downscaled frame and the last result is
   * reused between ticks. WebGPU only — on the wasm fallback, depth is
   * ~30s/frame, so live mode simply never requests it (falls back to
   * today's arm-capsule occlusion / unshaded rendering).
   */
  liveDepth: {
    fps: 5,
    maxDim: 256,
  },
} as const;
