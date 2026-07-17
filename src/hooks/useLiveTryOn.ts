import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { OneEuroKeypointSmoother } from '@practics/tryon-core';
import type { PipelineResult } from '@practics/tryon-core';
import type { UsePipeline } from './usePipeline';

export interface LiveFrame {
  /** The frame this result was computed from — also the display source. */
  frame: ImageBitmap;
  result: PipelineResult;
}

export interface UseLiveTryOn {
  latest: LiveFrame | null;
  /** Measured inference-loop rate (throttled to ~config.targetFps, lower under load). */
  fps: number;
  error: string | null;
}

/**
 * Throttled webcam inference loop: captures one frame per tick (~config.targetFps,
 * self-paced — never more than one inference in flight, dropped rather than
 * queued if a tick overruns), smooths keypoints across frames, and exposes
 * the latest {frame, result} pair for rendering.
 */
export function useLiveTryOn(
  pipeline: UsePipeline,
  videoEl: HTMLVideoElement | null,
  active: boolean,
): UseLiveTryOn {
  const [latest, setLatest] = useState<LiveFrame | null>(null);
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const latestRef = useRef<LiveFrame | null>(null);

  useEffect(() => {
    if (!active || !videoEl || pipeline.status !== 'ready') return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const smoother = new OneEuroKeypointSmoother(config.liveSmoothing);
    let lastTick: number | null = null;
    let emaFps = 0;
    const targetIntervalMs = 1000 / config.targetFps;
    // Smooth the displayed fps too — the instantaneous per-tick rate swings
    // a lot (GC pauses, video frame timing) and reads as noisy in a demo.
    const FPS_EMA_ALPHA = 0.25;

    const clear = (f: LiveFrame | null) => {
      f?.frame.close();
      f?.result.maskBitmap.close();
    };

    const tick = async () => {
      const tickStart = performance.now();
      try {
        if (videoEl.readyState >= 2) {
          // Two copies: the worker consumes (transfers) its input, so the
          // original is kept here as the display frame. The worker's copy is
          // downscaled to config.webcam.inferenceMaxWidth — display and
          // inference resolution are deliberately decoupled (see that
          // field's doc comment), with keypoints scaled back up below.
          const original = await createImageBitmap(videoEl);
          const scale = Math.min(1, config.webcam.inferenceMaxWidth / original.width);
          const inferW = Math.max(1, Math.round(original.width * scale));
          const inferH = Math.max(1, Math.round(original.height * scale));
          const copy = await createImageBitmap(original, {
            resizeWidth: inferW,
            resizeHeight: inferH,
          });
          const res = await pipeline.process(copy);
          if (cancelled) {
            original.close();
            res.maskBitmap.close();
            return;
          }

          // Back to display-frame pixel space: everything downstream
          // (smoothing state, anchor mapping, gestures, orientation) sees
          // one coordinate space — the display frame's.
          const sx = original.width / inferW;
          const sy = original.height / inferH;
          const displayKeypoints =
            sx === 1 && sy === 1
              ? res.keypoints
              : res.keypoints.map((kp) => ({ ...kp, x: kp.x * sx, y: kp.y * sy }));

          const smoothed = smoother.apply(displayKeypoints, tickStart, original.width);
          const next: LiveFrame = { frame: original, result: { ...res, keypoints: smoothed } };
          clear(latestRef.current);
          latestRef.current = next;
          setLatest(next);

          const now = performance.now();
          if (lastTick !== null && now > lastTick) {
            const instFps = 1000 / (now - lastTick);
            emaFps = emaFps === 0 ? instFps : FPS_EMA_ALPHA * instFps + (1 - FPS_EMA_ALPHA) * emaFps;
            setFps(emaFps);
          }
          lastTick = now;
        }
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          const elapsed = performance.now() - tickStart;
          timeoutId = setTimeout(() => void tick(), Math.max(0, targetIntervalMs - elapsed));
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      clear(latestRef.current);
      latestRef.current = null;
      setLatest(null);
      setFps(0);
    };
  }, [active, videoEl, pipeline.status, pipeline.process]);

  return { latest, fps, error };
}
