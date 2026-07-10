/**
 * Shared pipeline types. This module (and everything under src/pipeline/) is
 * framework-free: no React, no DOM assumptions beyond canvas/ImageBitmap,
 * usable from both the worker and the main thread.
 */

/** MoveNet keypoint order (COCO 17-keypoint convention). */
export const KEYPOINT_NAMES = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

export type KeypointName = (typeof KEYPOINT_NAMES)[number];

/** Skeleton connectivity for the debug overlay. */
export const SKELETON_EDGES: readonly (readonly [KeypointName, KeypointName])[] = [
  ['nose', 'left_eye'],
  ['nose', 'right_eye'],
  ['left_eye', 'left_ear'],
  ['right_eye', 'right_ear'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
] as const;

/** A detected keypoint in source-image pixel coordinates. */
export interface Keypoint {
  name: KeypointName;
  x: number;
  y: number;
  /** Confidence 0..1. */
  score: number;
}

export type Accelerator = 'webgpu' | 'wasm';

export interface PipelineTimings {
  segmentMs: number;
  poseMs: number;
  totalMs: number;
}

/** One processed frame/photo. */
export interface PipelineResult {
  keypoints: Keypoint[];
  /**
   * Person-confidence mask cropped to the source image's aspect ratio
   * (letterbox padding removed). Low-res; upscale when compositing.
   * Encoded in the alpha channel (white pixels, alpha = confidence).
   */
  maskBitmap: ImageBitmap;
  timings: PipelineTimings;
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

export interface InitRequest {
  type: 'init';
  wasmPath: string;
  modelPaths: { segmenter: string; pose: string };
  accelerator: Accelerator;
}

export interface ProcessRequest {
  type: 'process';
  /** Transferred, not cloned. The worker consumes (closes) it. */
  bitmap: ImageBitmap;
  seq: number;
}

export type WorkerRequest = InitRequest | ProcessRequest;

export interface ReadyResponse {
  type: 'ready';
  /** The accelerator actually in use (may differ from requested after fallback). */
  backend: Accelerator;
  initMs: number;
}

export interface ResultResponse {
  type: 'result';
  seq: number;
  keypoints: Keypoint[];
  maskBitmap: ImageBitmap;
  timings: PipelineTimings;
}

export interface ErrorResponse {
  type: 'error';
  seq?: number;
  message: string;
}

export type WorkerResponse = ReadyResponse | ResultResponse | ErrorResponse;
