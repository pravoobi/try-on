/**
 * LiteRT.js wrapper around the MediaPipe Selfie Segmenter (landscape) model.
 * Produces a person-confidence mask at model resolution plus helpers to turn
 * it into a compositing-ready ImageBitmap.
 */
import { loadAndCompile, type CompiledModel } from '@litertjs/core';
import { runWithTfjsTensors } from '@litertjs/tfjs-interop';
import * as tf from '@tensorflow/tfjs-core';
import { computeLetterbox, contentRect, type Letterbox } from './letterbox';
import { toModelInput } from './preprocess';
import type { Accelerator } from './types';

export interface SegmentationResult {
  /** Person confidence 0..1, row-major, at model output resolution. */
  data: Float32Array;
  width: number;
  height: number;
  /** Letterbox used for the input — maps mask pixels back to source pixels. */
  letterbox: Letterbox;
}

export class Segmenter {
  private constructor(
    private readonly model: CompiledModel,
    private readonly inputH: number,
    private readonly inputW: number,
  ) {}

  static async create(modelUrl: string, accelerator: Accelerator): Promise<Segmenter> {
    const model = await loadAndCompile(modelUrl, { accelerator });
    const input = model.getInputDetails()[0];
    if (!input || input.shape.length !== 4 || input.shape[3] !== 3) {
      throw new Error(`segmenter: unexpected input shape [${input?.shape ?? '?'}]`);
    }
    if (input.dtype !== 'float32') {
      throw new Error(`segmenter: expected float32 input, got ${input.dtype}`);
    }
    const h = input.shape[1];
    const w = input.shape[2];
    if (h === undefined || w === undefined) {
      throw new Error('segmenter: input shape missing spatial dims');
    }
    return new Segmenter(model, h, w);
  }

  async segment(source: ImageBitmap): Promise<SegmentationResult> {
    const lb = computeLetterbox(source.width, source.height, this.inputW, this.inputH);
    const input = toModelInput(source, lb, { dtype: 'float32', normalize: true });
    let outputs: tf.Tensor[];
    try {
      outputs = await runWithTfjsTensors(this.model, [input]);
    } finally {
      input.dispose();
    }
    try {
      const out = outputs[0];
      if (!out) throw new Error('segmenter: model produced no outputs');
      const shape = out.shape;
      const height = shape.length >= 3 ? shape[1] : this.inputH;
      const width = shape.length >= 3 ? shape[2] : this.inputW;
      const channels = shape.length === 4 ? shape[3] : 1;
      if (height !== this.inputH || width !== this.inputW) {
        throw new Error(
          `segmenter: output ${width}x${height} does not match input ${this.inputW}x${this.inputH}`,
        );
      }
      const raw = (await out.data()) as Float32Array;
      const data = extractPersonChannel(raw, width * height, channels);
      sigmoidIfLogits(data);
      return { data, width, height, letterbox: lb };
    } finally {
      for (const t of outputs) t.dispose();
    }
  }
}

/** For multi-channel outputs the last channel is the person class. */
function extractPersonChannel(raw: Float32Array, n: number, channels: number): Float32Array {
  if (channels <= 1) return raw.slice(0, n);
  const data = new Float32Array(n);
  const person = channels - 1;
  for (let i = 0; i < n; i++) data[i] = raw[i * channels + person];
  return data;
}

/**
 * Some segmenter exports include the sigmoid, some emit raw logits. Detect by
 * value range and normalize in place so callers always see 0..1.
 */
function sigmoidIfLogits(data: Float32Array): void {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  if (min >= -0.001 && max <= 1.001) return;
  for (let i = 0; i < data.length; i++) data[i] = 1 / (1 + Math.exp(-data[i]));
}

/**
 * Render the mask into an ImageBitmap with confidence in the alpha channel
 * (white fill), cropped to the source image's aspect (letterbox padding
 * removed). Low-res by design — upscale with smoothing when drawing.
 */
export async function maskToImageBitmap(mask: SegmentationResult): Promise<ImageBitmap> {
  const { data, width, height, letterbox } = mask;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const o = i * 4;
    pixels[o] = 255;
    pixels[o + 1] = 255;
    pixels[o + 2] = 255;
    pixels[o + 3] = Math.round(data[i] * 255);
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('maskToImageBitmap: no 2d context');
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  const rect = contentRect(letterbox);
  return createImageBitmap(canvas, rect.x, rect.y, rect.w, rect.h);
}
