/**
 * Exponential smoothing across frames to kill keypoint jitter in live video
 * (see CLAUDE.md Phase 3: smoothed = α·new + (1−α)·prev). Matched by name so
 * a keypoint that just appeared/disappeared doesn't smooth against garbage.
 */
import type { Keypoint } from './types';

function lerp(a: number, b: number, alpha: number): number {
  return alpha * b + (1 - alpha) * a;
}

/**
 * Blends `next` toward `prev` per keypoint (position and score alike — score
 * is smoothed too so a garment doesn't flicker on/off at the confidence
 * threshold). Pass `prev: null` for the first frame (returns `next` as-is).
 */
export function smoothKeypoints(
  prev: readonly Keypoint[] | null,
  next: readonly Keypoint[],
  alpha: number,
): Keypoint[] {
  if (!prev) return next.slice();
  const prevByName = new Map(prev.map((k) => [k.name, k] as const));
  return next.map((n) => {
    const p = prevByName.get(n.name);
    if (!p) return n;
    return {
      name: n.name,
      x: lerp(p.x, n.x, alpha),
      y: lerp(p.y, n.y, alpha),
      score: lerp(p.score, n.score, alpha),
    };
  });
}
