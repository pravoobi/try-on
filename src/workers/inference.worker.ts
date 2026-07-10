/**
 * Inference worker: owns the LiteRT.js runtime and both models. The main
 * thread talks to it via the typed protocol in pipeline/types.ts, transferring
 * ImageBitmaps in and receiving keypoints + a mask ImageBitmap back.
 */
import { getWebGpuDevice, isWebGPUSupported, loadLiteRt } from '@litertjs/core';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { WebGPUBackend } from '@tensorflow/tfjs-backend-webgpu';
import { PoseEstimator } from '../pipeline/pose';
import { maskToImageBitmap, Segmenter } from '../pipeline/segmenter';
import type {
  Accelerator,
  InitRequest,
  ProcessRequest,
  WorkerRequest,
  WorkerResponse,
} from '../pipeline/types';

const post = self.postMessage.bind(self) as (
  msg: WorkerResponse,
  transfer?: Transferable[],
) => void;

interface Pipeline {
  segmenter: Segmenter;
  pose: PoseEstimator;
  backend: Accelerator;
}

let pipeline: Pipeline | null = null;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'init') void init(msg);
  else if (msg.type === 'process') void process(msg);
};

async function init(msg: InitRequest): Promise<void> {
  const t0 = performance.now();
  try {
    await loadLiteRt(msg.wasmPath);
    const backend: Accelerator =
      msg.accelerator === 'webgpu' && isWebGPUSupported() ? 'webgpu' : 'wasm';

    const segmenter = await Segmenter.create(msg.modelPaths.segmenter, backend);
    const pose = await PoseEstimator.create(msg.modelPaths.pose, backend);

    await setupTfjsBackend(backend);

    pipeline = { segmenter, pose, backend };
    post({ type: 'ready', backend, initMs: performance.now() - t0 });
  } catch (err) {
    pipeline = null;
    post({ type: 'error', message: errorMessage(err) });
  }
}

/**
 * Preprocessing (pixels → tensor) runs on TFJS. With the webgpu accelerator,
 * register a TFJS WebGPU backend that shares LiteRT's GPUDevice so frames
 * never round-trip through the CPU (see LiteRT.js docs). Otherwise use the
 * TFJS cpu backend.
 */
async function setupTfjsBackend(backend: Accelerator): Promise<void> {
  if (backend === 'webgpu') {
    const device = getWebGpuDevice();
    if (device) {
      tf.registerBackend('webgpu', () => new WebGPUBackend(device, device.adapterInfo));
      await tf.setBackend('webgpu');
      return;
    }
    // Shared device unavailable: inference stays on WebGPU, preprocessing
    // falls back to CPU tensors (interop copies them in).
  }
  await tf.setBackend('cpu');
}

async function process(msg: ProcessRequest): Promise<void> {
  const { bitmap, seq } = msg;
  try {
    if (!pipeline) throw new Error('pipeline not initialized');
    const t0 = performance.now();
    const seg = await pipeline.segmenter.segment(bitmap);
    const t1 = performance.now();
    const keypoints = await pipeline.pose.estimate(bitmap);
    const t2 = performance.now();
    const maskBitmap = await maskToImageBitmap(seg);
    post(
      {
        type: 'result',
        seq,
        keypoints,
        maskBitmap,
        timings: { segmentMs: t1 - t0, poseMs: t2 - t1, totalMs: performance.now() - t0 },
      },
      [maskBitmap],
    );
  } catch (err) {
    post({ type: 'error', seq, message: errorMessage(err) });
  } finally {
    bitmap.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
