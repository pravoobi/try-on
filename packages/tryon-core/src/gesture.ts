/**
 * Hands-free gestures in live mode: a left/right hand swipe cycles the
 * garment list, an upward swipe triggers the photo-capture countdown.
 * Detected purely from the wrist keypoints MoveNet already produces every
 * frame — no new model, no added inference cost, fitting the project's
 * zero-marginal-cost pitch.
 *
 * A swipe is: one wrist moving monotonically along one axis across a
 * rolling time window by more than `minTravelFrac` of the frame WIDTH —
 * deliberately the same reference dimension for both axes (see
 * detectSwipeInBuffer's own comment for why using each axis's own
 * dimension, e.g. a landscape 4:3 frame's smaller height, silently biases
 * every swipe toward "vertical"). Monotonicity (never reversing direction
 * mid-window) rejects incidental hand jitter — scratching an itch or
 * resting a hand rarely moves in one steady direction for the whole
 * window. Losing a wrist's confidence resets ONLY that wrist's buffer: a
 * swipe must be one continuously-tracked motion, not a low-confidence
 * guess stitched across a tracking gap. Both wrists are tracked
 * independently so either hand can gesture.
 */
import type { Keypoint, KeypointName } from './types.js';

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
  /**
   * Return-stroke suppression: after a horizontal swipe, the hand travels
   * BACK — the same distance, monotonic, in the opposite direction — and
   * once past cooldownUntil that return fired as a real swipe, undoing the
   * one just made (field-reported as the garment never changing while the
   * swipe chevrons flashed on every motion). A swipe in `suppressDirection`
   * is ignored until `suppressUntil`; same-direction swipes only wait out
   * the ordinary cooldown.
   */
  suppressDirection: 'left' | 'right' | null;
  suppressUntil: number;
}

export const INITIAL_SWIPE_STATE: SwipeState = {
  left: EMPTY_BUFFER,
  right: EMPTY_BUFFER,
  cooldownUntil: 0,
  suppressDirection: null,
  suppressUntil: 0,
};

export interface SwipeConfig {
  /** Minimum travel across the window, as a fraction of frame WIDTH (the shared reference for both axes — see module comment), to count as a swipe. */
  minTravelFrac: number;
  /** Rolling time window a single swipe attempt is judged over, ms. */
  windowMs: number;
  /**
   * Minimum samples within the window before a swipe may fire — rejects a
   * 2-point fluke early in tracking. Keep this SMALL (samples arrive once
   * per inference tick, so a high count silently disables gestures when
   * fps drops under load); sustained-motion rejection is minSpanMs's job,
   * which is tick-rate-independent.
   */
  minSamples: number;
  /**
   * Minimum time (ms) the buffered motion must span, first sample to last,
   * before a swipe may fire. The time-based counterpart to minSamples: a
   * couple of glitchy keypoints microseconds apart can't fire no matter
   * how far apart they landed, while a genuine swipe tracked at any frame
   * rate — even a heavily-loaded 3fps — accumulates span in real time.
   */
  minSpanMs: number;
  /** No new swipe may fire within this many ms of the previous one — one motion should trigger one action. */
  cooldownMs: number;
  /**
   * How long after a horizontal swipe the OPPOSITE horizontal direction
   * stays suppressed (see SwipeState.suppressDirection — the return-stroke
   * problem). Longer than cooldownMs because a leisurely hand return lands
   * well after the ordinary cooldown; bounded so a user who genuinely wants
   * to reverse direction only waits this long.
   */
  oppositeCooldownMs: number;
  /** Wrist keypoint confidence required to extend a swipe buffer at all. */
  minKeypointScore: number;
  /**
   * How much more (in raw pixels) vertical travel must exceed horizontal
   * for an up/down swipe to win a mixed motion, e.g. 1.3 = 30% more.
   * Horizontal (garment cycling) is the primary, already-validated
   * gesture; a natural lateral swipe's hand often rises or dips a little
   * along the way, and an accidental capture-countdown trigger is far
   * more disruptive than an occasional missed cycle — so ties, and even
   * a mild vertical lead, should still resolve to left/right.
   */
  verticalDominanceMargin: number;
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
  allowUp: boolean,
  config: SwipeConfig,
): SwipeDirection | null {
  const { samples } = buf;
  if (samples.length < config.minSamples) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.t - first.t < config.minSpanMs) return null;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  // Both axes measured against frame WIDTH, not each axis's own dimension:
  // a 640x480 frame's height (480) is smaller than its width (640), so
  // thresholding vertical travel against frameHeight would let it cross
  // its own pass threshold — and read as "more dominant" — from LESS raw
  // pixel travel than an equally-sized horizontal motion needs. Both
  // effects silently biased every swipe toward "up/down", misfiring the
  // capture countdown on an ordinary left/right swipe whose hand rose or
  // dipped a little along the way (a natural side-to-side arm motion
  // rarely stays at one exact height).
  const passX = Math.abs(dx) / frameWidth >= config.minTravelFrac;
  const passY = Math.abs(dy) / frameWidth >= config.minTravelFrac;
  if (!passX && !passY) return null;

  // Vertical additionally needs verticalDominanceMargin's clear lead over
  // horizontal (in raw pixels) to win at all — see that field's own
  // comment for why ties favor left/right.
  const verticalWins = passY && Math.abs(dy) >= Math.abs(dx) * config.verticalDominanceMargin;
  if (passX && !verticalWins) {
    if (!isMonotonic(samples, 'x', Math.sign(dx))) return null;
    return dx > 0 ? 'right' : 'left';
  }
  if (!passY) return null;
  if (!isMonotonic(samples, 'y', Math.sign(dy))) return null;
  // image y increases downward, so dy < 0 is "up".
  if (dy < 0 && !allowUp) return null;
  return dy > 0 ? 'down' : 'up';
}

/**
 * "Up" (the photo-capture trigger) means *raising a hand overhead* — so it
 * only counts when the wrist actually ENDS above the shoulder line. The
 * lead-in of an ordinary sideways swipe is a hand LIFT from the side up to
 * chest height: a large, monotonic, vertical wrist motion. At low live
 * fps the fast horizontal part that follows often loses wrist tracking
 * (motion blur → confidence dip → buffer reset), leaving that cleanly
 * tracked lift as the whole judged window — which fired the capture
 * countdown on a swipe meant to change garments (user-reported). A lift
 * ends near the chest, below the shoulders, so this gate kills the
 * misfire while a deliberate overhead raise passes it easily. Shoulders
 * are MoveNet's most reliable keypoints; if neither is confident, "up" is
 * simply not offered (a capture gesture without a tracked torso is
 * suspect anyway).
 */
function wristEndsAboveShoulders(
  wrist: Keypoint | undefined,
  byName: ReadonlyMap<KeypointName, Keypoint>,
  config: SwipeConfig,
): boolean {
  if (!wrist) return false;
  const shoulders = [byName.get('left_shoulder'), byName.get('right_shoulder')].filter(
    (s): s is Keypoint => !!s && s.score >= config.minKeypointScore,
  );
  if (shoulders.length === 0) return false;
  const shoulderY = shoulders.reduce((acc, s) => acc + s.y, 0) / shoulders.length;
  return wrist.y < shoulderY;
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
  const leftKp = byName.get(WRIST_NAMES[0]);
  const rightKp = byName.get(WRIST_NAMES[1]);
  const left = updateWristBuffer(state.left, leftKp, nowMs, config);
  const right = updateWristBuffer(state.right, rightKp, nowMs, config);
  const carry = (swipe: null): SwipeUpdate => ({
    state: {
      left,
      right,
      cooldownUntil: state.cooldownUntil,
      suppressDirection: state.suppressDirection,
      suppressUntil: state.suppressUntil,
    },
    swipe,
  });

  if (nowMs < state.cooldownUntil) return carry(null);

  const swipe =
    detectSwipeInBuffer(left, frameWidth, wristEndsAboveShoulders(leftKp, byName, config), config) ??
    detectSwipeInBuffer(right, frameWidth, wristEndsAboveShoulders(rightKp, byName, config), config);
  if (!swipe) return carry(null);
  // The return stroke of the previous swipe (see SwipeState.suppressDirection).
  // CONSUME it — clear the buffers like a fire would, without firing —
  // otherwise the stroke's samples outlive the suppression window in the
  // rolling buffer and fire a spurious opposite swipe the moment it expires.
  if (swipe === state.suppressDirection && nowMs < state.suppressUntil) {
    return {
      state: {
        left: EMPTY_BUFFER,
        right: EMPTY_BUFFER,
        cooldownUntil: state.cooldownUntil,
        suppressDirection: state.suppressDirection,
        suppressUntil: state.suppressUntil,
      },
      swipe: null,
    };
  }

  // A completed swipe clears both buffers and starts the cooldown — the
  // motion that just fired shouldn't immediately chain into another — and a
  // horizontal swipe arms suppression of its own return direction.
  const suppressDirection = swipe === 'left' ? 'right' : swipe === 'right' ? 'left' : null;
  return {
    state: {
      left: EMPTY_BUFFER,
      right: EMPTY_BUFFER,
      cooldownUntil: nowMs + config.cooldownMs,
      suppressDirection,
      suppressUntil: suppressDirection ? nowMs + config.oppositeCooldownMs : 0,
    },
    swipe,
  };
}
