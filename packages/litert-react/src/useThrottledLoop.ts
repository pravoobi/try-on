import { useEffect, useRef, useState } from 'react';

export interface UseThrottledLoopResult {
  /** Smoothed (EMA) measured loop rate, in Hz. 0 while inactive. */
  fps: number;
}

/**
 * Self-pacing loop: calls `tick` roughly `targetFps` times per second,
 * never overlapping — the next call is scheduled `1/targetFps` seconds
 * after the *previous tick started*, minus however long it actually took,
 * so a slow tick is skipped-ahead rather than queued (no pile-up under
 * load). Typical use: capture a video frame, run inference on it, publish
 * the result — all inside `tick`.
 *
 * `tick` itself isn't a dependency (only `active`/`targetFps` restart the
 * loop) — pass a closure freely; the loop always calls the latest version
 * via a ref, so you don't need to memoize it yourself to avoid restarting
 * the whole loop on every render.
 */
export function useThrottledLoop(
  tick: () => Promise<void>,
  targetFps: number,
  active: boolean,
): UseThrottledLoopResult {
  const [fps, setFps] = useState(0);
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!active) {
      setFps(0);
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let lastTick: number | null = null;
    let emaFps = 0;
    const targetIntervalMs = 1000 / targetFps;
    const FPS_EMA_ALPHA = 0.25;

    const loop = async () => {
      const tickStart = performance.now();
      try {
        await tickRef.current();
      } catch {
        // A tick that throws still gets rescheduled below — a caller who
        // wants to surface the error does so from within `tick` itself
        // (e.g. via their own error state); this loop's only job is timing.
      }
      if (!cancelled) {
        const now = performance.now();
        if (lastTick !== null && now > lastTick) {
          const instFps = 1000 / (now - lastTick);
          emaFps = emaFps === 0 ? instFps : FPS_EMA_ALPHA * instFps + (1 - FPS_EMA_ALPHA) * emaFps;
          setFps(emaFps);
        }
        lastTick = now;
        const elapsed = performance.now() - tickStart;
        timeoutId = setTimeout(() => void loop(), Math.max(0, targetIntervalMs - elapsed));
      }
    };
    void loop();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      setFps(0);
    };
  }, [active, targetFps]);

  return { fps };
}
