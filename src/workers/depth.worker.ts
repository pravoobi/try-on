/**
 * Advanced-mode depth-estimation worker (Phase A1 — see
 * docs/plan-3d-garment-assets.md §5.0). Deliberately its own worker, fully
 * independent of inference.worker.ts: only this file imports
 * @huggingface/transformers, and this file is only ever instantiated after
 * the user opts into advanced mode (useAdvancedMode). Vite gives every
 * worker entry point its own chunk, so the ~50MB model + the transformers.js
 * runtime never touch the simple app's default bundle or startup.
 */
import { pipeline, RawImage } from '@huggingface/transformers';
import type { DepthAccelerator, DepthWorkerRequest, DepthWorkerResponse } from '../pipeline/depthTypes';

const post = self.postMessage.bind(self) as (
  msg: DepthWorkerResponse,
  transfer?: Transferable[],
) => void;

const MODEL_ID = 'onnx-community/depth-anything-v2-small';

type DepthEstimator = (image: RawImage) => Promise<{ depth: RawImage }>;

let estimator: DepthEstimator | null = null;

// Requests are serialized through this queue: the transformers.js pipeline
// wraps a single ONNX Runtime session, which isn't safe to invoke
// concurrently. Without this, two nearly-simultaneous 'process' messages
// (e.g. the person photo's depth and a garment's depth, both triggered by
// the same garment selection) can run estimator() overlapped and
// cross-contaminate their outputs — one request's result quietly leaking
// pixels from the other's input image.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<DepthWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    queue = queue.then(() => init(msg.device));
  } else if (msg.type === 'process') {
    queue = queue.then(() => process(msg.bitmap, msg.seq));
  }
};

async function init(device: DepthAccelerator): Promise<void> {
  const t0 = performance.now();
  try {
    estimator = (await pipeline('depth-estimation', MODEL_ID, {
      device,
      // wasm has no fp16 kernels to speak of; let it fall back to the
      // library's own default (int8) rather than forcing a dtype that
      // doesn't exist for that device.
      dtype: device === 'webgpu' ? 'fp16' : undefined,
      progress_callback: (p: { status: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress') {
          post({ type: 'progress', loaded: p.loaded ?? 0, total: p.total ?? 0 });
        }
      },
    })) as unknown as DepthEstimator;
    post({ type: 'ready', device, initMs: performance.now() - t0 });
  } catch (err) {
    estimator = null;
    post({ type: 'error', message: errorMessage(err) });
  }
}

async function process(bitmap: ImageBitmap, seq: number): Promise<void> {
  try {
    if (!estimator) throw new Error('depth estimator not initialized');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('depth worker: no 2d context');
    ctx.drawImage(bitmap, 0, 0);

    const t0 = performance.now();
    const image = await RawImage.read(canvas);
    const { depth } = await estimator(image);
    const depthCanvas = depth.toCanvas();
    const depthBitmap = await createImageBitmap(depthCanvas as unknown as ImageBitmapSource);
    post({ type: 'result', seq, depthBitmap, ms: performance.now() - t0 }, [depthBitmap]);
  } catch (err) {
    post({ type: 'error', seq, message: errorMessage(err) });
  } finally {
    bitmap.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
