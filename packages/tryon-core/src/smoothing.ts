/**
 * Exponential smoothing across frames to kill keypoint jitter in live video
 * (see CLAUDE.md Phase 3: smoothed = α·new + (1−α)·prev). Matched by name so
 * a keypoint that just appeared/disappeared doesn't smooth against garbage.
 */
import type { Keypoint } from './types.js';

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

export interface OneEuroParams {
  /**
   * Position cutoff (Hz) at standstill — the smoothing floor. Lower =
   * steadier when the subject holds still, at the cost of lag once they
   * move (which `beta` then buys back).
   */
  minCutoffHz: number;
  /**
   * How much measured speed raises the cutoff, in Hz per frame-width/second
   * (positions are normalized by frame width internally, so this is
   * resolution-independent). Higher = less lag during fast motion.
   */
  beta: number;
  /** Cutoff (Hz) for the internal speed estimate — the paper's dCutoff. */
  dCutoffHz: number;
  /** Keypoint scores aren't positions; they get a plain EMA with this factor. */
  scoreAlpha: number;
}

interface OneEuroAxis {
  value: number;
  velocity: number;
}

interface OneEuroEntry {
  x: OneEuroAxis;
  y: OneEuroAxis;
  score: number;
  tMs: number;
}

/** Ticks longer apart than this smooth against stale state — start that keypoint over instead. */
const RESET_GAP_MS = 1000;
/** dt clamp bounds (s): guards a zero/negative timestamp delta and caps how much history one slow tick discards. */
const MIN_DT_S = 1e-3;
const MAX_DT_S = 0.5;

function oneEuroAlpha(cutoffHz: number, dtS: number): number {
  // First-order low-pass: α = 1 / (1 + τ/dt), τ = 1/(2π·cutoff). Unlike a
  // fixed EMA factor, this keeps the filter's time constant stable when the
  // tick rate changes (live fps varies with load — see useThrottledLoop).
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

/**
 * One Euro filter over named keypoints (Casiez et al. 2012): a low-pass
 * whose cutoff rises with the signal's own speed. A fixed-α EMA has to pick
 * one point on the jitter↔lag tradeoff; this filter instead smooths hard at
 * low speeds — a standing subject's garment holds still — and follows
 * near-raw during fast motion, where lag (not jitter) is what the eye
 * notices. Stateful across frames: one instance per continuous tracking
 * session, `reset()` when the stream (re)starts.
 */
export class OneEuroKeypointSmoother {
  private entries = new Map<Keypoint['name'], OneEuroEntry>();

  constructor(private readonly params: OneEuroParams) {}

  reset(): void {
    this.entries.clear();
  }

  /**
   * Filters one frame's keypoints. `tMs` is the frame timestamp
   * (performance.now()-scale); `frameWidth` normalizes positions so params
   * are resolution-independent.
   */
  apply(keypoints: readonly Keypoint[], tMs: number, frameWidth: number): Keypoint[] {
    const { minCutoffHz, beta, dCutoffHz, scoreAlpha } = this.params;
    return keypoints.map((kp) => {
      const prev = this.entries.get(kp.name);
      const xNorm = kp.x / frameWidth;
      const yNorm = kp.y / frameWidth;
      if (!prev || tMs - prev.tMs > RESET_GAP_MS) {
        this.entries.set(kp.name, {
          x: { value: xNorm, velocity: 0 },
          y: { value: yNorm, velocity: 0 },
          score: kp.score,
          tMs,
        });
        return kp;
      }

      const dtS = Math.min(MAX_DT_S, Math.max(MIN_DT_S, (tMs - prev.tMs) / 1000));
      const dAlpha = oneEuroAlpha(dCutoffHz, dtS);
      const filterAxis = (axis: OneEuroAxis, next: number): OneEuroAxis => {
        const velocity = lerp(axis.velocity, (next - axis.value) / dtS, dAlpha);
        const cutoff = minCutoffHz + beta * Math.abs(velocity);
        return { value: lerp(axis.value, next, oneEuroAlpha(cutoff, dtS)), velocity };
      };

      const x = filterAxis(prev.x, xNorm);
      const y = filterAxis(prev.y, yNorm);
      const score = lerp(prev.score, kp.score, scoreAlpha);
      this.entries.set(kp.name, { x, y, score, tMs });
      return { name: kp.name, x: x.value * frameWidth, y: y.value * frameWidth, score };
    });
  }
}
