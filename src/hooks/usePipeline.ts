import { useCallback, useEffect, useRef, useState } from 'react';
import { config } from '../config';
import type {
  Accelerator,
  PipelineResult,
  WorkerRequest,
  WorkerResponse,
} from '../pipeline/types';

export type PipelineStatus = 'loading' | 'ready' | 'error';

interface Pending {
  resolve: (r: PipelineResult) => void;
  reject: (e: Error) => void;
}

export interface UsePipeline {
  status: PipelineStatus;
  /** Accelerator actually in use (after any fallback), once ready. */
  backend: Accelerator | null;
  initMs: number | null;
  error: string | null;
  /** Runs the pipeline on a bitmap. The bitmap is transferred (consumed). */
  process: (bitmap: ImageBitmap) => Promise<PipelineResult>;
}

export function usePipeline(accelerator: Accelerator): UsePipeline {
  const [status, setStatus] = useState<PipelineStatus>('loading');
  const [backend, setBackend] = useState<Accelerator | null>(null);
  const [initMs, setInitMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const seqRef = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/inference.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    const pending = pendingRef.current;
    setStatus('loading');
    setBackend(null);
    setInitMs(null);
    setError(null);

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'ready') {
        setStatus('ready');
        setBackend(msg.backend);
        setInitMs(msg.initMs);
      } else if (msg.type === 'result') {
        const p = pending.get(msg.seq);
        pending.delete(msg.seq);
        p?.resolve({ keypoints: msg.keypoints, maskBitmap: msg.maskBitmap, timings: msg.timings });
      } else if (msg.seq !== undefined) {
        const p = pending.get(msg.seq);
        pending.delete(msg.seq);
        p?.reject(new Error(msg.message));
      } else {
        setStatus('error');
        setError(msg.message);
      }
    };
    worker.onerror = (e) => {
      setStatus('error');
      setError(e.message || 'worker crashed');
    };

    const init: WorkerRequest = {
      type: 'init',
      wasmPath: config.litertWasmPath,
      modelPaths: config.models,
      accelerator,
    };
    worker.postMessage(init);

    return () => {
      worker.terminate();
      workerRef.current = null;
      for (const p of pending.values()) p.reject(new Error('pipeline torn down'));
      pending.clear();
    };
  }, [accelerator]);

  const process = useCallback((bitmap: ImageBitmap): Promise<PipelineResult> => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error('pipeline not running'));
    const seq = ++seqRef.current;
    return new Promise<PipelineResult>((resolve, reject) => {
      pendingRef.current.set(seq, { resolve, reject });
      const req: WorkerRequest = { type: 'process', bitmap, seq };
      worker.postMessage(req, [bitmap]);
    });
  }, []);

  return { status, backend, initMs, error, process };
}
