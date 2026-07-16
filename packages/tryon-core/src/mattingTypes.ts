/**
 * Worker protocol for the garment-upload matting worker. Framework-free,
 * like depthTypes.ts — importing this file never pulls transformers.js
 * into a consuming app's main bundle. Only matting.worker.ts imports the
 * library itself.
 */
import type { GarmentExtractOptions } from './garmentExtract.js';

export type MattingAccelerator = 'webgpu' | 'wasm';

export interface MattingInitRequest {
  type: 'init';
  device: MattingAccelerator;
  /** Overrides DEFAULT_GARMENT_EXTRACT_CONFIG (see config.ts) for this session. */
  garmentExtractConfig?: GarmentExtractOptions;
}

export interface MattingProcessRequest {
  type: 'process';
  /** Transferred, not cloned. The worker consumes (closes) it. */
  bitmap: ImageBitmap;
  seq: number;
}

export type MattingWorkerRequest = MattingInitRequest | MattingProcessRequest;

export interface MattingProgressResponse {
  type: 'progress';
  loaded: number;
  total: number;
}

export interface MattingReadyResponse {
  type: 'ready';
  device: MattingAccelerator;
  initMs: number;
}

export interface MattingResultResponse {
  type: 'result';
  seq: number;
  /** Background-removed RGBA image, same pixel dimensions as the input bitmap. */
  mattedBitmap: ImageBitmap;
  ms: number;
}

export interface MattingErrorResponse {
  type: 'error';
  seq?: number;
  message: string;
}

export type MattingWorkerResponse =
  | MattingProgressResponse
  | MattingReadyResponse
  | MattingResultResponse
  | MattingErrorResponse;
