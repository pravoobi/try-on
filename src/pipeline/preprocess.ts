/**
 * ImageBitmap → model input tensor, staying on the active TFJS backend
 * (WebGPU when available — avoids per-frame GPU↔CPU pixel readback).
 */
import * as tf from '@tensorflow/tfjs-core';
import type { Letterbox } from './letterbox';

export interface ModelInputSpec {
  dtype: 'int32' | 'float32';
  /** Divide by 255 (float models). int32 models get raw 0–255 values. */
  normalize: boolean;
}

/**
 * Resize with preserved aspect ratio, pad with black to the target size
 * (letterbox — never stretch), batch-dim added. Caller owns disposal.
 */
export function toModelInput(
  source: ImageBitmap,
  lb: Letterbox,
  spec: ModelInputSpec,
): tf.Tensor4D {
  return tf.tidy(() => {
    const img = tf.browser.fromPixels(source, 3);
    const resized = tf.image.resizeBilinear(img, [lb.scaledH, lb.scaledW]);
    const padded = tf.pad(resized, [
      [lb.dy, lb.targetH - lb.scaledH - lb.dy],
      [lb.dx, lb.targetW - lb.scaledW - lb.dx],
      [0, 0],
    ]);
    const scaled = spec.normalize ? tf.div(padded, 255) : padded;
    const cast = spec.dtype === 'int32' ? tf.cast(tf.round(scaled), 'int32') : scaled;
    return tf.expandDims(cast, 0) as tf.Tensor4D;
  });
}
