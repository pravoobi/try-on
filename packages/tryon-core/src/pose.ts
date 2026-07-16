/**
 * LiteRT.js wrapper around MoveNet SinglePose Lightning.
 * Output: 17 keypoints in source-image pixel coordinates.
 *
 * Runs through LiteRT's native Tensor API rather than tfjs-interop: the
 * published TFLite file takes uint8 input, which tfjs tensors can't express
 * (tfjs-interop is int32/float32 only). Preprocessing happens on a 192×192
 * OffscreenCanvas — small enough that CPU pixel readback is negligible.
 */
import { loadAndCompile, Tensor, type CompiledModel } from '@litertjs/core';
import { clamp, computeLetterbox, type Letterbox } from './letterbox.js';
import { unletterboxPoint } from './letterbox.js';
import { KEYPOINT_NAMES, type Accelerator, type Keypoint } from './types.js';

type PoseDtype = 'uint8' | 'int32' | 'float32';

export class PoseEstimator {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  private constructor(
    private readonly model: CompiledModel,
    private readonly inputH: number,
    private readonly inputW: number,
    private readonly dtype: PoseDtype,
  ) {
    this.canvas = new OffscreenCanvas(inputW, inputH);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('pose: no 2d context for preprocessing');
    this.ctx = ctx;
  }

  static async create(modelUrl: string, accelerator: Accelerator): Promise<PoseEstimator> {
    const model = await loadAndCompile(modelUrl, { accelerator });
    const input = model.getInputDetails()[0];
    if (!input || input.shape.length !== 4 || input.shape[3] !== 3) {
      throw new Error(`pose: unexpected input shape [${input?.shape ?? '?'}]`);
    }
    // All MoveNet TFLite exports take raw 0–255 RGB; only the dtype varies.
    const dtype = input.dtype as PoseDtype;
    if (dtype !== 'uint8' && dtype !== 'int32' && dtype !== 'float32') {
      throw new Error(`pose: unsupported input dtype ${String(input.dtype)}`);
    }
    const output = model.getOutputDetails()[0];
    if (output && output.dtype !== 'float32') {
      throw new Error(`pose: expected float32 output, got ${output.dtype}`);
    }
    const h = input.shape[1];
    const w = input.shape[2];
    if (h === undefined || w === undefined) {
      throw new Error('pose: input shape missing spatial dims');
    }
    return new PoseEstimator(model, h, w, dtype);
  }

  async estimate(source: ImageBitmap): Promise<Keypoint[]> {
    const lb = computeLetterbox(source.width, source.height, this.inputW, this.inputH);
    const input = new Tensor(this.preprocess(source, lb), [1, this.inputH, this.inputW, 3]);
    let outputs: Tensor[];
    try {
      outputs = await this.model.run([input]);
    } finally {
      input.delete();
    }
    try {
      const out = outputs[0];
      if (!out) throw new Error('pose: model produced no outputs');
      const data = await out.data();
      if (data.length < KEYPOINT_NAMES.length * 3) {
        throw new Error(`pose: unexpected output size ${data.length}`);
      }
      // Output is [1,1,17,3] = (y, x, score), coords normalized to the
      // (letterboxed) model input. Un-letterbox back to source pixels.
      return KEYPOINT_NAMES.map((name, i) => {
        const y = data[i * 3] * this.inputH;
        const x = data[i * 3 + 1] * this.inputW;
        const score = data[i * 3 + 2];
        const p = unletterboxPoint(x, y, lb);
        return {
          name,
          x: clamp(p.x, 0, source.width),
          y: clamp(p.y, 0, source.height),
          score,
        };
      });
    } finally {
      for (const t of outputs) t.delete();
    }
  }

  /** Letterboxed RGB pixels (0–255) in the model's dtype; padding is black. */
  private preprocess(
    source: ImageBitmap,
    lb: Letterbox,
  ): Uint8Array<ArrayBuffer> | Int32Array<ArrayBuffer> | Float32Array<ArrayBuffer> {
    this.ctx.clearRect(0, 0, this.inputW, this.inputH);
    this.ctx.drawImage(source, lb.dx, lb.dy, lb.scaledW, lb.scaledH);
    const rgba = this.ctx.getImageData(0, 0, this.inputW, this.inputH).data;
    const n = this.inputW * this.inputH;
    const rgb =
      this.dtype === 'uint8'
        ? new Uint8Array(n * 3)
        : this.dtype === 'int32'
          ? new Int32Array(n * 3)
          : new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = rgba[i * 4];
      rgb[i * 3 + 1] = rgba[i * 4 + 1];
      rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return rgb;
  }
}
