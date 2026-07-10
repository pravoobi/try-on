/** All tunables and paths live here (see CLAUDE.md conventions). */
export const config = {
  models: {
    segmenter: '/models/selfie_segmenter_landscape.tflite',
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
} as const;
