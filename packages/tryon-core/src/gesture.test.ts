import { describe, expect, it } from 'vitest';
import {
  INITIAL_SWIPE_STATE,
  updateSwipeDetection,
  type SwipeConfig,
  type SwipeDirection,
  type SwipeState,
} from './gesture';
import type { Keypoint } from './types';

const CONFIG: SwipeConfig = {
  minTravelFrac: 0.22,
  windowMs: 700,
  minSamples: 3,
  minSpanMs: 250,
  cooldownMs: 900,
  oppositeCooldownMs: 1600,
  minKeypointScore: 0.2,
  verticalDominanceMargin: 1.3,
};

const FRAME_WIDTH = 640;

/** Shoulder line for the default test skeleton — "up" only fires when the wrist ends above it. */
const SHOULDER_Y = 350;

function wristAt(name: 'left_wrist' | 'right_wrist', x: number, y: number, score = 0.9): Keypoint[] {
  return [
    { name, x, y, score },
    { name: 'left_shoulder', x: 280, y: SHOULDER_Y, score: 0.9 },
    { name: 'right_shoulder', x: 380, y: SHOULDER_Y, score: 0.9 },
  ];
}

/** Feeds a sequence of (x, y) samples through the detector, returning the final state and any swipes seen along the way. */
function feed(
  state: SwipeState,
  name: 'left_wrist' | 'right_wrist',
  points: [number, number][],
  stepMs: number,
  startMs = 1000,
): { state: SwipeState; swipes: (SwipeDirection | null)[] } {
  let s = state;
  let t = startMs;
  const swipes: (SwipeDirection | null)[] = [];
  for (const [x, y] of points) {
    const result = updateSwipeDetection(s, wristAt(name, x, y), FRAME_WIDTH, t, CONFIG);
    s = result.state;
    swipes.push(result.swipe);
    t += stepMs;
  }
  return { state: s, swipes };
}

const Y0 = 300; // fixed y for pure-horizontal test motions
const X0 = 300; // fixed x for pure-vertical test motions

describe('updateSwipeDetection', () => {
  it('fires "right" for a steady left-to-right wrist motion past the travel threshold', () => {
    // 640 * 0.22 ≈ 141px minimum travel; go well past it.
    const pts: [number, number][] = [100, 130, 160, 190, 220, 250, 280].map((x) => [x, Y0]);
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['right']);
  });

  it('fires "left" for a steady right-to-left wrist motion', () => {
    const pts: [number, number][] = [280, 250, 220, 190, 160, 130, 100].map((x) => [x, Y0]);
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'left_wrist', pts, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['left']);
  });

  it('fires "up" for a steady upward wrist motion (decreasing image-y)', () => {
    // Both axes measured against frame WIDTH (640 * 0.22 ≈ 141px minimum); go well past it.
    const pts: [number, number][] = [400, 370, 340, 310, 280, 250, 220].map((y) => [X0, y]);
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['up']);
  });

  it('fires "down" for a steady downward wrist motion', () => {
    const pts: [number, number][] = [100, 130, 160, 190, 220, 250, 280].map((y) => [X0, y]);
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['down']);
  });

  it('regression: a left swipe with realistic vertical wobble still fires "left", not "up"', () => {
    // A real hand swipe rarely stays at one exact height — this reproduces
    // a reported bug where left/right swipes were misfiring as "up"
    // (triggering the photo capture) because vertical travel was measured
    // against frameHeight (480, smaller than frameWidth's 640), letting it
    // cross its own pass threshold — and read as "dominant" — from LESS
    // raw pixel travel than an equal-magnitude horizontal motion needed.
    // Both axes now share frameWidth as the reference, removing the bias.
    const pts: [number, number][] = [
      [300, 300],
      [270, 328],
      [240, 356],
      [210, 384],
      [180, 412],
      [150, 440],
    ];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['left']);
  });

  it('regression: a hand LIFT ending below the shoulders never fires "up" (capture countdown)', () => {
    // The lead-in to a real sideways swipe: hand rises from the side up to
    // chest height — large monotonic vertical travel, but ending BELOW the
    // shoulder line. At low live fps the horizontal part that follows often
    // loses wrist tracking, so this lift was the entire judged window and
    // started the photo countdown on a swipe meant to cycle garments.
    const pts: [number, number][] = [620, 560, 500, 440, 400].map((y) => [X0, y]); // ends 400 > SHOULDER_Y 350
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 120);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('the same upward motion ending above the shoulders does fire "up"', () => {
    const pts: [number, number][] = [520, 460, 400, 340, 280].map((y) => [X0, y]); // ends 280 < SHOULDER_Y 350
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 120);
    expect(swipes.filter((s) => s !== null)).toEqual(['up']);
  });

  it('does not offer "up" at all when no shoulder is confidently tracked', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    for (const y of [520, 460, 400, 340, 280]) {
      const kps: Keypoint[] = [{ name: 'right_wrist', x: X0, y, score: 0.9 }];
      const r = updateSwipeDetection(state, kps, FRAME_WIDTH, t, CONFIG);
      state = r.state;
      expect(r.swipe).toBeNull();
      t += 120;
    }
  });

  it('lets a clearly-dominant vertical motion still win despite some horizontal drift', () => {
    const pts: [number, number][] = [
      [300, 400],
      [305, 370],
      [310, 340],
      [315, 310],
      [320, 280],
      [325, 250],
    ];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['up']);
  });

  it('picks the dominant axis on a diagonal motion', () => {
    // Large horizontal travel (180px, well past threshold), small vertical drift (30px, below threshold).
    const pts: [number, number][] = [
      [100, 300],
      [130, 305],
      [160, 308],
      [190, 312],
      [220, 318],
      [250, 325],
      [280, 330],
    ];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['right']);
  });

  it('does not fire when travel stays below the threshold on both axes', () => {
    const pts: [number, number][] = [
      [100, 300],
      [110, 305],
      [120, 308],
      [130, 300],
      [140, 295],
      [150, 300],
    ];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('does not fire on a jittery, non-monotonic wrist path even with large total spread', () => {
    const pts: [number, number][] = [100, 250, 110, 260, 105, 255, 100].map((x) => [x, Y0]);
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 70);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('does not fire before minSamples worth of tracking has accumulated', () => {
    // Big jump in just 2 samples should NOT fire (minSamples=3).
    const pts: [number, number][] = [
      [100, Y0],
      [300, Y0],
    ];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 300);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('does not fire when the motion spans less than minSpanMs, however large the travel', () => {
    // Three samples 60ms apart = 120ms total span < 250ms — a glitch-speed
    // "motion", not a human swipe, even though travel is far past threshold.
    const pts: [number, number][] = [100, 250, 400].map((x) => [x, Y0]);
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 60);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('fires at low sample rates (heavy-load live fps) once the motion spans minSpanMs', () => {
    // Regression: minSamples used to be 5 in a 700ms window, which needs
    // ≥7fps to ever be satisfiable — advanced-mode live runs slower than
    // that, silently disabling gestures. 3 samples 333ms apart is ~3fps.
    const pts: [number, number][] = [100, 240, 380].map((x) => [x, Y0]);
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', pts, 333);
    expect(swipes.filter((s) => s !== null)).toEqual(['right']);
  });

  it('resets the buffer when the wrist drops below confidence, requiring a fresh continuous motion', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    for (const x of [100, 130, 160, 190]) {
      const r = updateSwipeDetection(state, wristAt('right_wrist', x, Y0), FRAME_WIDTH, t, CONFIG);
      state = r.state;
      t += 70;
    }
    const dropped = updateSwipeDetection(state, [], FRAME_WIDTH, t, CONFIG);
    expect(dropped.state.right.samples).toHaveLength(0);
    t += 70;
    const resumed = updateSwipeDetection(dropped.state, wristAt('right_wrist', 190, Y0), FRAME_WIDTH, t, CONFIG);
    expect(resumed.swipe).toBeNull();
  });

  it('enforces a cooldown after a fired swipe', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    const pts: [number, number][] = [100, 130, 160, 190, 220, 250, 280].map((x) => [x, Y0]);
    const first = feed(state, 'right_wrist', pts, 70, t);
    expect(first.swipes.filter((s) => s !== null)).toEqual(['right']);
    state = first.state;
    t += 7 * 70;

    const pts2: [number, number][] = [280, 310, 340, 370, 400, 430, 460].map((x) => [x, Y0]);
    const second = feed(state, 'right_wrist', pts2, 70, t + 10);
    expect(second.swipes.every((s) => s === null)).toBe(true);
  });

  it('allows a new same-direction swipe once the cooldown has elapsed', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    const pts: [number, number][] = [100, 130, 160, 190, 220, 250, 280].map((x) => [x, Y0]);
    const first = feed(state, 'right_wrist', pts, 70, t);
    expect(first.swipes.filter((s) => s !== null)).toEqual(['right']);
    state = first.state;
    t += 7 * 70;

    const pts2: [number, number][] = [100, 130, 160, 190, 220, 250, 280].map((x) => [x, Y0]);
    const second = feed(state, 'left_wrist', pts2, 70, t + CONFIG.cooldownMs + 10);
    expect(second.swipes.filter((s) => s !== null)).toEqual(['right']);
  });

  it('regression: the return stroke after a swipe does not fire the opposite swipe', () => {
    // Swipe right, then bring the hand back left ~1s later — the return
    // retraces the same travel monotonically in the opposite direction and
    // used to fire a real "left", undoing the change the swipe just made
    // (seen in the field as the garment ping-ponging in place while the
    // swipe feedback flashed on every motion).
    const rightPts: [number, number][] = [100, 130, 160, 190, 220, 250, 280].map((x) => [x, Y0]);
    const first = feed(INITIAL_SWIPE_STATE, 'right_wrist', rightPts, 70, 1000); // fires 'right' ~t=1350
    expect(first.swipes.filter((s) => s !== null)).toEqual(['right']);

    const returnPts: [number, number][] = [280, 240, 200, 160, 120, 80].map((x) => [x, Y0]);
    const returned = feed(first.state, 'right_wrist', returnPts, 100, 2350); // past cooldown, inside suppression
    expect(returned.swipes.every((s) => s === null)).toBe(true);

    // The NEXT intended swipe (same direction) still works.
    const againPts: [number, number][] = [80, 120, 160, 200, 240, 280, 320].map((x) => [x, Y0]);
    const again = feed(returned.state, 'right_wrist', againPts, 100, 3000);
    expect(again.swipes.filter((s) => s !== null)).toEqual(['right']);
  });

  it('a deliberate direction reversal fires once oppositeCooldownMs has passed', () => {
    const rightPts: [number, number][] = [100, 130, 160, 190, 220, 250, 280].map((x) => [x, Y0]);
    const first = feed(INITIAL_SWIPE_STATE, 'right_wrist', rightPts, 70, 1000); // fires ~t=1350, suppression until ~2950
    const leftPts: [number, number][] = [280, 240, 200, 160, 120, 80].map((x) => [x, Y0]);
    const reversed = feed(first.state, 'right_wrist', leftPts, 100, 3100);
    expect(reversed.swipes.filter((s) => s !== null)).toEqual(['left']);
  });

  it('tracks left and right wrists independently — an idle low-confidence wrist does not block the other', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    for (const x of [100, 130, 160, 190, 220, 250, 280]) {
      const kps: Keypoint[] = [
        { name: 'left_wrist', x: 300, y: 300, score: 0.05 },
        { name: 'right_wrist', x, y: Y0, score: 0.9 },
      ];
      const r = updateSwipeDetection(state, kps, FRAME_WIDTH, t, CONFIG);
      state = r.state;
      if (r.swipe) expect(r.swipe).toBe('right');
      t += 70;
    }
  });
});
