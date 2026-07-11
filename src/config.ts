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
  /** Exponential smoothing factor for live keypoints (Phase 3): s = α·new + (1−α)·prev. */
  smoothingAlpha: 0.4,
  /** Live inference throttle target (Phase 3). */
  targetFps: 15,
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
  },
  /** TPS warp evaluation grid (see pipeline/warp.ts). */
  warpGrid: { cols: 16, rows: 24 },
  /** Arm-occlusion capsule radius, as a fraction of shoulder-to-shoulder width. */
  armOcclusionRadiusFactor: 0.14,
} as const;
