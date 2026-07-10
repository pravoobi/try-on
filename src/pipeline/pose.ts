/**
 * LiteRT.js wrapper around MoveNet SinglePose Lightning.
 * Output: 17 keypoints in source-image pixel coordinates.
 */
import { loadAndCompile, type CompiledModel } from '@litertjs/core';
import { runWithTfjsTensors } from '@litertjs/tfjs-interop';
import type * as tf from '@tensorflow/tfjs-core';
import { clamp, computeLetterbox, unletterboxPoint } from './letterbox';
import { toModelInput } from './preprocess';
import { KEYPOINT_NAMES, type Accelerator, type Keypoint } from './types';

export class PoseEstimator {
  private constructor(
    private readonly model: CompiledModel,
    private readonly inputH: number,
    private readonly inputW: number,
    private readonly dtype: 'int32' | 'float32',
  ) {}

  static async create(modelUrl: string, accelerator: Accelerator): Promise<PoseEstimator> {
    const model = await loadAndCompile(modelUrl, { accelerator });
    const input = model.getInputDetails()[0];
    if (!input || input.shape.length !== 4 || input.shape[3] !== 3) {
      throw new Error(`pose: unexpected input shape [${input?.shape ?? '?'}]`);
    }
    // MoveNet TFLite takes int32 RGB 0–255 (per model card); tolerate float32
    // exports, which also take 0–255.
    if (input.dtype !== 'int32' && input.dtype !== 'float32') {
      throw new Error(`pose: unsupported input dtype ${input.dtype}`);
    }
    const h = input.shape[1];
    const w = input.shape[2];
    if (h === undefined || w === undefined) {
      throw new Error('pose: input shape missing spatial dims');
    }
    return new PoseEstimator(model, h, w, input.dtype);
  }

  async estimate(source: ImageBitmap): Promise<Keypoint[]> {
    const lb = computeLetterbox(source.width, source.height, this.inputW, this.inputH);
    const input = toModelInput(source, lb, { dtype: this.dtype, normalize: false });
    let outputs: tf.Tensor[];
    try {
      outputs = await runWithTfjsTensors(this.model, [input]);
    } finally {
      input.dispose();
    }
    try {
      const out = outputs[0];
      if (!out) throw new Error('pose: model produced no outputs');
      const data = (await out.data()) as Float32Array;
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
      for (const t of outputs) t.dispose();
    }
  }
}
