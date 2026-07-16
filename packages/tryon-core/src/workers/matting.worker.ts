/**
 * Garment-upload extraction worker. Deliberately its own worker,
 * independent of both the inference and depth workers: it's only needed
 * for the upload flow, so it's created (and its models downloaded) lazily
 * on first use, separately from any depth-estimation model. Bundlers give
 * it its own chunk.
 *
 * Two models run per photo: background removal (MODNet — soft foreground
 * alpha) and clothes parsing (SegFormer human-parsing — per-pixel garment
 * vs body-part labels). Background removal alone keeps the whole salient
 * foreground, so a photo of someone WEARING the garment would keep the
 * person too; the parse is what lets garmentExtract.ts strip the wearer
 * (head, arms, legs, non-target clothing) and keep just the garment.
 * Flat-lay photos (no person detected) skip extraction entirely and use
 * the plain matting result — see garmentExtract.ts for the decision logic.
 */
import { env, pipeline, RawImage } from '@huggingface/transformers';
import { DEFAULT_GARMENT_EXTRACT_CONFIG } from '../config.js';
import { extractGarmentAlpha, type GarmentExtractOptions, type LabelMask } from '../garmentExtract.js';
import type { MattingAccelerator, MattingWorkerRequest, MattingWorkerResponse } from '../mattingTypes.js';

// A one-time model download only stays one-time if the browser cache
// actually persists across sessions.
env.useBrowserCache = true;

const post = self.postMessage.bind(self) as (
  msg: MattingWorkerResponse,
  transfer?: Transferable[],
) => void;

// transformers.js's own maintained default for the 'background-removal'
// task — safer than guessing at an unverified model id (e.g. RMBG-1.4)
// that may not have a compatible ONNX export for this library version.
const MATTING_MODEL_ID = 'Xenova/modnet';
// SegFormer-B2 fine-tuned for human/clothes parsing (18 classes:
// Upper-clothes, Dress, Face, Left-arm, ... — see garmentExtract.ts).
const PARSING_MODEL_ID = 'Xenova/segformer_b2_clothes';

type MattingPipeline = (image: RawImage) => Promise<RawImage>;
type ParsingPipeline = (
  image: RawImage,
) => Promise<Array<{ label: string | null; mask: RawImage }>>;

let matter: MattingPipeline | null = null;
let parser: ParsingPipeline | null = null;
let garmentExtractConfig: GarmentExtractOptions = DEFAULT_GARMENT_EXTRACT_CONFIG;

// Requests are serialized through this queue: the underlying ONNX Runtime
// session isn't safe to invoke concurrently.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<MattingWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    if (msg.garmentExtractConfig) garmentExtractConfig = msg.garmentExtractConfig;
    queue = queue.then(() => init(msg.device));
  } else if (msg.type === 'process') {
    queue = queue.then(() => process(msg.bitmap, msg.seq));
  }
};

async function init(device: MattingAccelerator): Promise<void> {
  const t0 = performance.now();
  const progress_callback = (p: { status: string; loaded?: number; total?: number }) => {
    if (p.status === 'progress') {
      post({ type: 'progress', loaded: p.loaded ?? 0, total: p.total ?? 0 });
    }
  };
  try {
    matter = (await pipeline('background-removal', MATTING_MODEL_ID, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : undefined,
      progress_callback,
    })) as unknown as MattingPipeline;
    parser = (await pipeline('image-segmentation', PARSING_MODEL_ID, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : undefined,
      progress_callback,
    })) as unknown as ParsingPipeline;
    post({ type: 'ready', device, initMs: performance.now() - t0 });
  } catch (err) {
    matter = null;
    parser = null;
    post({ type: 'error', message: errorMessage(err) });
  }
}

async function process(bitmap: ImageBitmap, seq: number): Promise<void> {
  try {
    if (!matter || !parser) throw new Error('matting models not initialized');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('matting worker: no 2d context');
    ctx.drawImage(bitmap, 0, 0);

    const t0 = performance.now();
    const image = await RawImage.read(canvas);
    const matted = await matter(image); // RGBA, background already transparent
    const segments = await parser(image); // one binary mask per detected label

    const w = matted.width;
    const h = matted.height;
    const rgba = matted.data;
    const foregroundAlpha = new Uint8ClampedArray(w * h);
    for (let i = 0; i < foregroundAlpha.length; i++) {
      foregroundAlpha[i] = rgba[i * 4 + 3];
    }

    // Semantic masks come back at the input image's own size; skip any
    // that don't match (defensive — shouldn't happen for this model).
    const labelMasks: LabelMask[] = segments
      .filter((s) => s.label !== null && s.mask.width === w && s.mask.height === h)
      .map((s) => ({ label: s.label as string, maskData: new Uint8ClampedArray(s.mask.data) }));

    const extraction = extractGarmentAlpha(foregroundAlpha, labelMasks, w, h, garmentExtractConfig);
    if (extraction.kind === 'garment') {
      for (let i = 0; i < w * h; i++) {
        rgba[i * 4 + 3] = extraction.alpha[i];
      }
    } else if (extraction.kind === 'no-garment-found') {
      throw new Error(
        "found a person in the photo, but couldn't isolate a top or dress on them — " +
          'make sure the garment is clearly visible, or use a flat-lay photo of just the garment',
      );
    }
    // 'no-person' (flat-lay / hanger photo): keep the plain matting result.

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
