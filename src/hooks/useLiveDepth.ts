import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import type { UseAdvancedMode } from './useAdvancedMode';

export interface UseLiveDepth {
  /** Latest person-depth estimate, reused between throttled ticks. Null until the first tick resolves. */
  depth: ImageBitmap | null;
}

/**
 * Throttled person-depth estimation for live mode (Phase A5, see
 * docs/plan-3d-garment-assets.md §5.5): depth inference is too slow to run
 * every pose-tick (~100-300ms even on WebGPU, per the A1 notes) without
 * cratering the live framerate, so this runs on its own slower timer
 * (config.liveDepth.fps) against a downscaled copy (config.liveDepth.maxDim)
 * of the latest live frame, and holds the last result between ticks — depth
 * changes slowly relative to pose, so a slightly stale depth map is a fine
 * trade for never blocking the pose loop.
 *
 * WebGPU only: on the wasm fallback, depth inference is ~30s/frame (A1
 * notes), so this hook simply never issues a request there — live mode
 * silently keeps today's arm-capsule occlusion / unshaded rendering instead
 * (matches §5.5's "CPU/Wasm fallback: depth at photo-mode only").
 */
export function useLiveDepth(advanced: UseAdvancedMode, frame: ImageBitmap | null, active: boolean): UseLiveDepth {
  const [depth, setDepth] = useState<ImageBitmap | null>(null);
  const depthRef = useRef<ImageBitmap | null>(null);
  const frameRef = useRef<ImageBitmap | null>(null);
  const busyRef = useRef(false);

  frameRef.current = frame;

  const enabled = active && advanced.status === 'ready' && advanced.device === 'webgpu';

  useEffect(() => {
    if (!enabled) {
      depthRef.current?.close();
      depthRef.current = null;
      setDepth(null);
      return;
    }

    let cancelled = false;
    const intervalMs = 1000 / config.liveDepth.fps;

    const tick = async () => {
      if (cancelled || busyRef.current) return;
      const current = frameRef.current;
      if (!current) return;
      busyRef.current = true;
      try {
        const maxDim = config.liveDepth.maxDim;
        const scale = Math.min(1, maxDim / Math.max(current.width, current.height));
        const dw = Math.max(1, Math.round(current.width * scale));
        const dh = Math.max(1, Math.round(current.height * scale));
        const small = new OffscreenCanvas(dw, dh);
        const smallCtx = small.getContext('2d');
        if (!smallCtx) return;
        smallCtx.drawImage(current, 0, 0, dw, dh);
        const bitmap = await createImageBitmap(small);
        const result = await advanced.estimateDepth(bitmap);
        if (cancelled) {
          result.close();
          return;
        }
        depthRef.current?.close();
        depthRef.current = result;
        setDepth(result);
      } catch {
        // Best-effort; occlusion/shading just fall back to the previous (or no) depth this tick.
      } finally {
        busyRef.current = false;
      }
    };

    const id = setInterval(() => void tick(), intervalMs);
    void tick();

    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, advanced.estimateDepth]);

  return { depth };
}
