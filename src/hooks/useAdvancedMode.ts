import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DepthAccelerator,
  DepthWorkerRequest,
  DepthWorkerResponse,
} from '../pipeline/depthTypes';

const STORAGE_KEY = 'try-on:advancedMode';

export type AdvancedModeStatus = 'off' | 'downloading' | 'ready' | 'error';

interface Pending {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (e: Error) => void;
}

export interface UseAdvancedMode {
  /** Whether the user has opted in (persisted). Flipping this mounts/tears down the depth worker. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  status: AdvancedModeStatus;
  /** Model-download progress in [0,1], or null before download starts / once ready. */
  progress: number | null;
  device: DepthAccelerator | null;
  error: string | null;
  /** True if this browser exposes navigator.gpu — advanced mode still works without it, just slower (wasm). */
  webgpuSupported: boolean;
  /** Runs depth estimation on a bitmap. The bitmap is transferred (consumed). Rejects if not ready. */
  estimateDepth: (bitmap: ImageBitmap) => Promise<ImageBitmap>;
}

/**
 * Gate for the whole advanced-mode feature (see docs/plan-3d-garment-assets.md
 * §5.0): the depth worker — and the ~50MB model it downloads — is created
 * only while `enabled` is true, so a user who never opts in never pays for
 * either. Toggling off tears the worker down immediately, no reload needed.
 */
export function useAdvancedMode(): UseAdvancedMode {
  const [enabled, setEnabledState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [status, setStatus] = useState<AdvancedModeStatus>('off');
  const [progress, setProgress] = useState<number | null>(null);
  const [device, setDevice] = useState<DepthAccelerator | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webgpuSupported = typeof navigator !== 'undefined' && 'gpu' in navigator;

  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const seqRef = useRef(0);
  // Aggregate progress across every model file transformers.js reports on.
  const fileProgressRef = useRef(new Map<string | undefined, { loaded: number; total: number }>());

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Best-effort persistence; advanced mode still works for this session.
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      setProgress(null);
      setDevice(null);
      setError(null);
      return;
    }

    const worker = new Worker(new URL('../workers/depth.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    const pending = pendingRef.current;
    fileProgressRef.current.clear();
    setStatus('downloading');
    setProgress(0);
    setDevice(null);
    setError(null);

    worker.onmessage = (e: MessageEvent<DepthWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        // No per-file identifier is threaded through to the caller here, so
        // approximate: track a running loaded/total across whatever this
        // event stream has reported so far. Good enough for a progress bar.
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
        setDevice(msg.device);
      } else if (msg.type === 'result') {
        const p = pending.get(msg.seq);
        pending.delete(msg.seq);
        p?.resolve(msg.depthBitmap);
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
      setError(e.message || 'depth worker crashed');
    };

    const init: DepthWorkerRequest = {
      type: 'init',
      device: webgpuSupported ? 'webgpu' : 'wasm',
    };
    worker.postMessage(init);

    return () => {
      worker.terminate();
      workerRef.current = null;
      for (const p of pending.values()) p.reject(new Error('advanced mode disabled'));
      pending.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const estimateDepth = useCallback((bitmap: ImageBitmap): Promise<ImageBitmap> => {
    const worker = workerRef.current;
    if (!worker) {
      bitmap.close();
      return Promise.reject(new Error('advanced mode not enabled'));
    }
    const seq = ++seqRef.current;
    return new Promise<ImageBitmap>((resolve, reject) => {
      pendingRef.current.set(seq, { resolve, reject });
      const req: DepthWorkerRequest = { type: 'process', bitmap, seq };
      worker.postMessage(req, [bitmap]);
    });
  }, []);

  return { enabled, setEnabled, status, progress, device, error, webgpuSupported, estimateDepth };
}
