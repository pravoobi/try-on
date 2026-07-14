/**
 * Hands-free garment cycling in live mode: a left/right hand swipe
 * advances/retreats through the garment list. Detected purely from the
 * wrist keypoints MoveNet already produces every frame — no new model, no
 * added inference cost, fitting the project's zero-marginal-cost pitch.
 *
 * A swipe is: one wrist's x-position moving monotonically across a rolling
 * time window by more than `minTravelFrac` of the frame width. Monotonicity
 * (never reversing direction mid-window) rejects incidental hand jitter —
 * scratching an itch or resting a hand rarely moves in one steady direction
 * for the whole window. Losing a wrist's confidence resets ONLY that
 * wrist's buffer: a swipe must be one continuously-tracked motion, not a
 * low-confidence guess stitched across a tracking gap. Both wrists are
 * tracked independently so either hand can gesture.
 */
import type { Keypoint, KeypointName } from './types';

interface WristSample {
  x: number;
  t: number;
}

interface WristBuffer {
  samples: readonly WristSample[];
}

const EMPTY_BUFFER: WristBuffer = { samples: [] };

export interface SwipeState {
  left: WristBuffer;
  right: WristBuffer;
  /** No new swipe may fire before this timestamp (performance.now()-scale). */
  cooldownUntil: number;
}

export const INITIAL_SWIPE_STATE: SwipeState = { left: EMPTY_BUFFER, right: EMPTY_BUFFER, cooldownUntil: 0 };

export interface SwipeConfig {
  /** Minimum horizontal travel across the window, as a fraction of frame width, to count as a swipe. */
  minTravelFrac: number;
  /** Rolling time window a single swipe attempt is judged over, ms. */
  windowMs: number;
  /** Minimum samples within the window before a swipe may fire — rejects a 2-point fluke early in tracking. */
  minSamples: number;
  /** No new swipe may fire within this many ms of the previous one — one motion should change one garment. */
  cooldownMs: number;
  /** Wrist keypoint confidence required to extend a swipe buffer at all. */
  minKeypointScore: number;
}

export type SwipeDirection = 'left' | 'right';

function updateWristBuffer(
  buf: WristBuffer,
  kp: Keypoint | undefined,
  nowMs: number,
  config: SwipeConfig,
): WristBuffer {
  if (!kp || kp.score < config.minKeypointScore) return EMPTY_BUFFER;
  const samples = [...buf.samples, { x: kp.x, t: nowMs }].filter((s) => nowMs - s.t <= config.windowMs);
  return { samples };
}

function detectSwipeInBuffer(buf: WristBuffer, frameWidth: number, config: SwipeConfig): SwipeDirection | null {
  const { samples } = buf;
  if (samples.length < config.minSamples) return null;
  const travel = samples[samples.length - 1].x - samples[0].x;
  if (Math.abs(travel) / frameWidth < config.minTravelFrac) return null;

  const sign = Math.sign(travel);
  for (let i = 1; i < samples.length; i++) {
    if (Math.sign(samples[i].x - samples[i - 1].x) === -sign) return null;
  }
  return sign > 0 ? 'right' : 'left';
}

export interface SwipeUpdate {
  state: SwipeState;
  swipe: SwipeDirection | null;
}

const WRIST_NAMES: readonly KeypointName[] = ['left_wrist', 'right_wrist'];

/** Feeds one frame's keypoints into the rolling detector; returns the (possibly unchanged) state and a direction if a swipe just completed. */
export function updateSwipeDetection(
  state: SwipeState,
  keypoints: readonly Keypoint[],
  frameWidth: number,
  nowMs: number,
  config: SwipeConfig,
): SwipeUpdate {
  const byName = new Map(keypoints.map((k) => [k.name, k] as const));
  const left = updateWristBuffer(state.left, byName.get(WRIST_NAMES[0]), nowMs, config);
  const right = updateWristBuffer(state.right, byName.get(WRIST_NAMES[1]), nowMs, config);

  if (nowMs < state.cooldownUntil) {
    return { state: { left, right, cooldownUntil: state.cooldownUntil }, swipe: null };
  }

  const swipe = detectSwipeInBuffer(left, frameWidth, config) ?? detectSwipeInBuffer(right, frameWidth, config);
  if (!swipe) {
    return { state: { left, right, cooldownUntil: state.cooldownUntil }, swipe: null };
  }
  // A completed swipe clears both buffers and starts the cooldown — the
  // motion that just fired shouldn't immediately chain into another.
  return { state: { left: EMPTY_BUFFER, right: EMPTY_BUFFER, cooldownUntil: nowMs + config.cooldownMs }, swipe };
}
