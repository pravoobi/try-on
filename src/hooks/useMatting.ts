import { useCallback, useEffect, useRef, useState } from 'react';
import { createMattingWorker } from '@practics/tryon-core/workers';
import type { MattingWorkerRequest, MattingWorkerResponse } from '@practics/tryon-core';
import { config } from '../config';

export type MattingStatus = 'off' | 'downloading' | 'ready' | 'error';

interface Pending {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (e: Error) => void;
}

export interface UseMatting {
  /** Whether the matting worker should exist. Unlike useAdvancedMode, not
   * persisted — the upload flow lazily enables this on first use each
   * session, rather than it being a standing preference. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  status: MattingStatus;
  /** Model-download progress in [0,1], or null before download starts / once ready. */
  progress: number | null;
  error: string | null;
  /** Runs background removal on a bitmap. The bitmap is transferred (consumed). Rejects if not ready. */
  removeBackground: (bitmap: ImageBitmap) => Promise<ImageBitmap>;
}

/**
 * Gate for the garment-upload matting model (Phase A4, see
 * docs/plan-3d-garment-assets.md §5.2). Lazily creates matting.worker.ts —
 * and downloads its model — only once the upload flow is actually opened,
 * independent of (and lazier than) useAdvancedMode's depth model. Toggling
 * off tears the worker down immediately.
 */
export function useMatting(): UseMatting {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<MattingStatus>('off');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webgpuSupported = typeof navigator !== 'undefined' && 'gpu' in navigator;

  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const seqRef = useRef(0);
  const fileProgressRef = useRef(new Map<string, { loaded: number; total: number }>());

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      setProgress(null);
      setError(null);
      return;
    }

    const worker = createMattingWorker();
    workerRef.current = worker;
    const pending = pendingRef.current;
    fileProgressRef.current.clear();
    setStatus('downloading');
    setProgress(0);
    setError(null);

    worker.onmessage = (e: MessageEvent<MattingWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const key = `${msg.total}`;
        fileProgressRef.current.set(key, { loaded: msg.loaded, total: msg.total });
        let loaded = 0;
        let total = 0;
        for (const f of fileProgressRef.current.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        setProgress(total > 0 ? loaded / total : 0);
      } else if (msg.type === 'ready') {
        setStatus('ready');
        setProgress(null);
      } else if (msg.type === 'result') {
        const p = pending.get(msg.seq);
        pending.delete(msg.seq);
        p?.resolve(msg.mattedBitmap);
      } else if (msg.type === 'error') {
        if (msg.seq !== undefined) {
          const p = pending.get(msg.seq);
          pending.delete(msg.seq);
          p?.reject(new Error(msg.message));
        } else {
          setStatus('error');
          setError(msg.message);
        }
      }
    };
    worker.onerror = (e) => {
      setStatus('error');
      setError(e.message || 'matting worker crashed');
    };

    const init: MattingWorkerRequest = {
      type: 'init',
      device: webgpuSupported ? 'webgpu' : 'wasm',
      garmentExtractConfig: config.garmentExtract,
    };
    worker.postMessage(init);

    return () => {
      worker.terminate();
      workerRef.current = null;
      for (const p of pending.values()) p.reject(new Error('matting disabled'));
      pending.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const removeBackground = useCallback((bitmap: ImageBitmap): Promise<ImageBitmap> => {
    const worker = workerRef.current;
    if (!worker) {
      bitmap.close();
      return Promise.reject(new Error('matting not enabled'));
    }
    const seq = ++seqRef.current;
    return new Promise<ImageBitmap>((resolve, reject) => {
      pendingRef.current.set(seq, { resolve, reject });
      const req: MattingWorkerRequest = { type: 'process', bitmap, seq };
      worker.postMessage(req, [bitmap]);
    });
  }, []);

  return { enabled, setEnabled, status, progress, error, removeBackground };
}
