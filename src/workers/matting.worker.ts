/**
 * Garment-upload background-removal worker (Phase A4 — see
 * docs/plan-3d-garment-assets.md §5.2). Deliberately its own worker,
 * independent of both inference.worker.ts and depth.worker.ts: it's only
 * needed for the upload flow, so it's created (and its model downloaded)
 * lazily on first use of "upload your own garment", separately from
 * advanced mode's depth model. Vite gives it its own chunk.
 */
import { env, pipeline, RawImage } from '@huggingface/transformers';
import type {
  MattingAccelerator,
  MattingWorkerRequest,
  MattingWorkerResponse,
} from '../pipeline/mattingTypes';

// See depth.worker.ts's identical line for why this is explicit rather
// than left to the library default: a one-time model download only stays
// one-time if the browser cache actually persists across sessions.
env.useBrowserCache = true;

const post = self.postMessage.bind(self) as (
  msg: MattingWorkerResponse,
  transfer?: Transferable[],
) => void;

// transformers.js's own maintained default for the 'background-removal'
// task — safer than guessing at an unverified model id (e.g. RMBG-1.4)
// that may not have a compatible ONNX export for this library version.
const MODEL_ID = 'Xenova/modnet';

type MattingPipeline = (image: RawImage) => Promise<RawImage>;

let matter: MattingPipeline | null = null;

// Requests are serialized through this queue — same reasoning as
// depth.worker.ts: the underlying ONNX Runtime session isn't safe to
// invoke concurrently, and this project already hit a real cross-
// contamination bug (Phase A2/A3) from not queueing.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<MattingWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    queue = queue.then(() => init(msg.device));
  } else if (msg.type === 'process') {
    queue = queue.then(() => process(msg.bitmap, msg.seq));
  }
};

async function init(device: MattingAccelerator): Promise<void> {
  const t0 = performance.now();
  try {
    matter = (await pipeline('background-removal', MODEL_ID, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : undefined,
      progress_callback: (p: { status: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress') {
          post({ type: 'progress', loaded: p.loaded ?? 0, total: p.total ?? 0 });
        }
      },
    })) as unknown as MattingPipeline;
    post({ type: 'ready', device, initMs: performance.now() - t0 });
  } catch (err) {
    matter = null;
    post({ type: 'error', message: errorMessage(err) });
  }
}

async function process(bitmap: ImageBitmap, seq: number): Promise<void> {
  try {
    if (!matter) throw new Error('matting model not initialized');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('matting worker: no 2d context');
    ctx.drawImage(bitmap, 0, 0);

    const t0 = performance.now();
    const image = await RawImage.read(canvas);
    const matted = await matter(image);
    const mattedCanvas = matted.toCanvas();
    const mattedBitmap = await createImageBitmap(mattedCanvas as unknown as ImageBitmapSource);
    post({ type: 'result', seq, mattedBitmap, ms: performance.now() - t0 }, [mattedBitmap]);
  } catch (err) {
    post({ type: 'error', seq, message: errorMessage(err) });
  } finally {
    bitmap.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
