import { describe, expect, it } from 'vitest';
import { INITIAL_SWIPE_STATE, updateSwipeDetection, type SwipeConfig, type SwipeState } from './gesture';
import type { Keypoint } from './types';

const CONFIG: SwipeConfig = {
  minTravelFrac: 0.22,
  windowMs: 700,
  minSamples: 5,
  cooldownMs: 900,
  minKeypointScore: 0.3,
};

const FRAME_WIDTH = 640;

function wrist(name: 'left_wrist' | 'right_wrist', x: number, score = 0.9): Keypoint[] {
  return [{ name, x, y: 300, score }];
}

/** Feeds a sequence of (x, dt) samples through the detector, returning the final state and any swipe seen along the way. */
function feed(
  state: SwipeState,
  name: 'left_wrist' | 'right_wrist',
  xs: number[],
  stepMs: number,
  startMs = 1000,
): { state: SwipeState; swipes: (import('./gesture').SwipeDirection | null)[] } {
  let s = state;
  let t = startMs;
  const swipes: (import('./gesture').SwipeDirection | null)[] = [];
  for (const x of xs) {
    const result = updateSwipeDetection(s, wrist(name, x), FRAME_WIDTH, t, CONFIG);
    s = result.state;
    swipes.push(result.swipe);
    t += stepMs;
  }
  return { state: s, swipes };
}

describe('updateSwipeDetection', () => {
  it('fires "right" for a steady left-to-right wrist motion past the travel threshold', () => {
    // 640 * 0.22 ≈ 141px minimum travel; go well past it.
    const xs = [100, 130, 160, 190, 220, 250, 280];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', xs, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['right']);
  });

  it('fires "left" for a steady right-to-left wrist motion', () => {
    const xs = [280, 250, 220, 190, 160, 130, 100];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'left_wrist', xs, 70);
    expect(swipes.filter((s) => s !== null)).toEqual(['left']);
  });

  it('does not fire when travel stays below the threshold', () => {
    const xs = [100, 110, 120, 130, 140, 150]; // 50px total, well under 141px
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', xs, 70);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('does not fire on a jittery, non-monotonic wrist path even with large total spread', () => {
    const xs = [100, 250, 110, 260, 105, 255, 100];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', xs, 70);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('does not fire before minSamples worth of tracking has accumulated', () => {
    // Big jump in just 2 samples should NOT fire (minSamples=5).
    const xs = [100, 300];
    const { swipes } = feed(INITIAL_SWIPE_STATE, 'right_wrist', xs, 70);
    expect(swipes.every((s) => s === null)).toBe(true);
  });

  it('resets the buffer when the wrist drops below confidence, requiring a fresh continuous motion', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    // Build up most of a swipe...
    for (const x of [100, 130, 160, 190]) {
      const r = updateSwipeDetection(state, wrist('right_wrist', x), FRAME_WIDTH, t, CONFIG);
      state = r.state;
      t += 70;
    }
    // ...then lose tracking entirely for a frame.
    const dropped = updateSwipeDetection(state, [], FRAME_WIDTH, t, CONFIG);
    expect(dropped.state.right.samples).toHaveLength(0);
    t += 70;
    // Resuming at the old endpoint alone (single sample) shouldn't immediately fire.
    const resumed = updateSwipeDetection(dropped.state, wrist('right_wrist', 190), FRAME_WIDTH, t, CONFIG);
    expect(resumed.swipe).toBeNull();
  });

  it('enforces a cooldown after a fired swipe', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    const first = feed(state, 'right_wrist', [100, 130, 160, 190, 220, 250, 280], 70, t);
    expect(first.swipes.filter((s) => s !== null)).toEqual(['right']);
    state = first.state;
    t += 7 * 70;

    // Immediately attempt another swipe well within the cooldown window.
    const second = feed(state, 'right_wrist', [280, 310, 340, 370, 400, 430, 460], 70, t + 10);
    expect(second.swipes.every((s) => s === null)).toBe(true);
  });

  it('allows a new swipe once the cooldown has elapsed', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    const first = feed(state, 'right_wrist', [100, 130, 160, 190, 220, 250, 280], 70, t);
    state = first.state;
    t += 7 * 70;

    // Wait past cooldownMs (900ms) before the next attempt.
    const second = feed(state, 'left_wrist', [280, 250, 220, 190, 160, 130, 100], 70, t + CONFIG.cooldownMs + 10);
    expect(second.swipes.filter((s) => s !== null)).toEqual(['left']);
  });

  it('tracks left and right wrists independently — an idle low-confidence wrist does not block the other', () => {
    let state = INITIAL_SWIPE_STATE;
    let t = 1000;
    for (const x of [100, 130, 160, 190, 220, 250, 280]) {
      const kps: Keypoint[] = [
        { name: 'left_wrist', x: 300, y: 300, score: 0.05 }, // idle, low confidence
        { name: 'right_wrist', x, y: 300, score: 0.9 },
      ];
      const r = updateSwipeDetection(state, kps, FRAME_WIDTH, t, CONFIG);
      state = r.state;
      if (r.swipe) expect(r.swipe).toBe('right');
      t += 70;
    }
  });
});
