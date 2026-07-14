/**
 * Hands-free gestures in live mode: a left/right hand swipe cycles the
 * garment list, an upward swipe triggers the photo-capture countdown.
 * Detected purely from the wrist keypoints MoveNet already produces every
 * frame — no new model, no added inference cost, fitting the project's
 * zero-marginal-cost pitch.
 *
 * A swipe is: one wrist moving monotonically along one axis across a
 * rolling time window by more than `minTravelFrac` of that axis's frame
 * dimension. Monotonicity (never reversing direction mid-window) rejects
 * incidental hand jitter — scratching an itch or resting a hand rarely
 * moves in one steady direction for the whole window. When both axes pass
 * the threshold (a diagonal motion), the axis with the larger relative
 * travel wins, so a mostly-horizontal-with-some-drift swipe still reads as
 * left/right rather than being rejected outright. Losing a wrist's
 * confidence resets ONLY that wrist's buffer: a swipe must be one
 * continuously-tracked motion, not a low-confidence guess stitched across a
 * tracking gap. Both wrists are tracked independently so either hand can
 * gesture.
 */
import type { Keypoint, KeypointName } from './types';

interface WristSample {
  x: number;
  y: number;
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
  /** Minimum travel across the window, as a fraction of the relevant frame dimension (width for left/right, height for up/down), to count as a swipe. */
  minTravelFrac: number;
  /** Rolling time window a single swipe attempt is judged over, ms. */
  windowMs: number;
  /** Minimum samples within the window before a swipe may fire — rejects a 2-point fluke early in tracking. */
  minSamples: number;
  /** No new swipe may fire within this many ms of the previous one — one motion should trigger one action. */
  cooldownMs: number;
  /** Wrist keypoint confidence required to extend a swipe buffer at all. */
  minKeypointScore: number;
}

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

function updateWristBuffer(
  buf: WristBuffer,
  kp: Keypoint | undefined,
  nowMs: number,
  config: SwipeConfig,
): WristBuffer {
  if (!kp || kp.score < config.minKeypointScore) return EMPTY_BUFFER;
  const samples = [...buf.samples, { x: kp.x, y: kp.y, t: nowMs }].filter((s) => nowMs - s.t <= config.windowMs);
  return { samples };
}

function isMonotonic(samples: readonly WristSample[], axis: 'x' | 'y', sign: number): boolean {
  for (let i = 1; i < samples.length; i++) {
    if (Math.sign(samples[i][axis] - samples[i - 1][axis]) === -sign) return false;
  }
  return true;
}

function detectSwipeInBuffer(
  buf: WristBuffer,
  frameWidth: number,
  frameHeight: number,
  config: SwipeConfig,
): SwipeDirection | null {
  const { samples } = buf;
  if (samples.length < config.minSamples) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const fracX = dx / frameWidth;
  const fracY = dy / frameHeight;
  const passX = Math.abs(fracX) >= config.minTravelFrac;
  const passY = Math.abs(fracY) >= config.minTravelFrac;
  if (!passX && !passY) return null;

  // Dominant axis wins a diagonal motion — compared as a fraction of each
  // axis's own frame dimension, so a 640x480 frame doesn't bias toward
  // "horizontal" just because the frame itself is wider than it is tall.
  if (passX && (!passY || Math.abs(fracX) >= Math.abs(fracY))) {
    if (!isMonotonic(samples, 'x', Math.sign(dx))) return null;
    return dx > 0 ? 'right' : 'left';
  }
  if (!isMonotonic(samples, 'y', Math.sign(dy))) return null;
  return dy > 0 ? 'down' : 'up'; // image y increases downward.
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
  frameHeight: number,
  nowMs: number,
  config: SwipeConfig,
): SwipeUpdate {
  const byName = new Map(keypoints.map((k) => [k.name, k] as const));
  const left = updateWristBuffer(state.left, byName.get(WRIST_NAMES[0]), nowMs, config);
  const right = updateWristBuffer(state.right, byName.get(WRIST_NAMES[1]), nowMs, config);

  if (nowMs < state.cooldownUntil) {
    return { state: { left, right, cooldownUntil: state.cooldownUntil }, swipe: null };
  }

  const swipe =
    detectSwipeInBuffer(left, frameWidth, frameHeight, config) ??
    detectSwipeInBuffer(right, frameWidth, frameHeight, config);
  if (!swipe) {
    return { state: { left, right, cooldownUntil: state.cooldownUntil }, swipe: null };
  }
  // A completed swipe clears both buffers and starts the cooldown — the
  // motion that just fired shouldn't immediately chain into another.
  return { state: { left: EMPTY_BUFFER, right: EMPTY_BUFFER, cooldownUntil: nowMs + config.cooldownMs }, swipe };
}
