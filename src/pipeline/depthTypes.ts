/**
 * Worker protocol for the advanced-mode depth-estimation worker (Phase A1,
 * see docs/plan-3d-garment-assets.md §5.0/§5.2). Framework-free, like
 * pipeline/types.ts — this file has no dependency on @huggingface/transformers
 * so importing it (e.g. from the main-thread hook) never pulls the ~50MB
 * model-loading library into the simple app's bundle. Only depth.worker.ts
 * imports transformers.js itself.
 */

export type DepthAccelerator = 'webgpu' | 'wasm';

export interface DepthInitRequest {
  type: 'init';
  device: DepthAccelerator;
}

export interface DepthProcessRequest {
  type: 'process';
  /** Transferred, not cloned. The worker consumes (closes) it. */
  bitmap: ImageBitmap;
  seq: number;
}

export type DepthWorkerRequest = DepthInitRequest | DepthProcessRequest;

/** Model-file download progress, forwarded from transformers.js's progress_callback. */
export interface DepthProgressResponse {
  type: 'progress';
  loaded: number;
  total: number;
}

export interface DepthReadyResponse {
  type: 'ready';
  /** The device actually in use (may differ from requested if unsupported). */
  device: DepthAccelerator;
  initMs: number;
}

export interface DepthResultResponse {
  type: 'result';
  seq: number;
  /** Grayscale depth map, same pixel dimensions as the input bitmap. */
  depthBitmap: ImageBitmap;
  ms: number;
}

export interface DepthErrorResponse {
  type: 'error';
  seq?: number;
  message: string;
}

export type DepthWorkerResponse =
  | DepthProgressResponse
  | DepthReadyResponse
  | DepthResultResponse
  | DepthErrorResponse;
