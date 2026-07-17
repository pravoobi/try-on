import { describe, expect, it } from 'vitest';
import { OneEuroKeypointSmoother, smoothKeypoints, type OneEuroParams } from './smoothing';
import type { Keypoint } from './types';

function kp(name: Keypoint['name'], x: number, y: number, score = 1): Keypoint {
  return { name, x, y, score };
}

describe('smoothKeypoints', () => {
  it('passes next through unchanged on the first frame (prev = null)', () => {
    const next = [kp('nose', 10, 20), kp('left_shoulder', 30, 40)];
    const out = smoothKeypoints(null, next, 0.4);
    expect(out).toEqual(next);
    expect(out).not.toBe(next); // defensive copy, not the same array
  });

  it('blends toward next by alpha: smoothed = α·new + (1−α)·prev', () => {
    const prev = [kp('nose', 0, 0, 0)];
    const next = [kp('nose', 100, 200, 1)];
    const out = smoothKeypoints(prev, next, 0.25);
    expect(out[0].x).toBeCloseTo(25, 6);
    expect(out[0].y).toBeCloseTo(50, 6);
    expect(out[0].score).toBeCloseTo(0.25, 6);
  });

  it('alpha=1 reduces to the new value; alpha=0 reduces to the previous value', () => {
    const prev = [kp('nose', 5, 5, 0.5)];
    const next = [kp('nose', 50, 60, 0.9)];
    expect(smoothKeypoints(prev, next, 1)).toEqual(next);
    const held = smoothKeypoints(prev, next, 0);
    expect(held[0].x).toBeCloseTo(5, 6);
    expect(held[0].y).toBeCloseTo(5, 6);
    expect(held[0].score).toBeCloseTo(0.5, 6);
  });

  it('leaves a keypoint unsmoothed if it has no match in prev (e.g. just appeared)', () => {
    const prev = [kp('nose', 0, 0)];
    const next = [kp('nose', 10, 10), kp('left_ankle', 99, 99)];
    const out = smoothKeypoints(prev, next, 0.3);
    const ankle = out.find((k) => k.name === 'left_ankle');
    expect(ankle).toEqual(kp('left_ankle', 99, 99));
  });

  it('preserves output order matching next, independent of prev order', () => {
    const prev = [kp('left_hip', 1, 1), kp('nose', 2, 2)];
    const next = [kp('nose', 3, 3), kp('left_hip', 4, 4)];
    const out = smoothKeypoints(prev, next, 0.5);
    expect(out.map((k) => k.name)).toEqual(['nose', 'left_hip']);
  });
});

describe('OneEuroKeypointSmoother', () => {
  const PARAMS: OneEuroParams = { minCutoffHz: 0.4, beta: 3.0, dCutoffHz: 1.0, scoreAlpha: 0.3 };
  const FRAME_WIDTH = 1280;
  const TICK_MS = 100; // ~10fps live

  it('passes the first frame through unchanged', () => {
    const f = new OneEuroKeypointSmoother(PARAMS);
    const next = [kp('nose', 10, 20, 0.8)];
    expect(f.apply(next, 1000, FRAME_WIDTH)).toEqual(next);
  });

  it('holds a constant input exactly (no drift)', () => {
    const f = new OneEuroKeypointSmoother(PARAMS);
    let out: Keypoint[] = [];
    for (let i = 0; i < 10; i++) out = f.apply([kp('nose', 500, 300)], 1000 + i * TICK_MS, FRAME_WIDTH);
    expect(out[0].x).toBeCloseTo(500, 6);
    expect(out[0].y).toBeCloseTo(300, 6);
  });

  it('suppresses standstill jitter far below its raw amplitude', () => {
    // ±3px alternating noise around a still point — the "garment moves on a
    // still subject" case. The adaptive cutoff should sit near its floor
    // and squash this to a fraction of a pixel.
    const f = new OneEuroKeypointSmoother(PARAMS);
    let maxDev = 0;
    for (let i = 0; i < 30; i++) {
      const x = 500 + (i % 2 === 0 ? 3 : -3);
      const out = f.apply([kp('nose', x, 300)], 1000 + i * TICK_MS, FRAME_WIDTH);
      if (i >= 10) maxDev = Math.max(maxDev, Math.abs(out[0].x - 500));
    }
    expect(maxDev).toBeLessThan(1.5);
  });

  it('tracks fast motion with bounded lag (cutoff opens up with speed)', () => {
    // 400px/s ramp — swipe-speed motion. A fixed EMA at the α this filter
    // uses at standstill (~0.2 at 10fps) would lag ~160px behind a ramp
    // like this; the speed-adaptive cutoff must do much better.
    const f = new OneEuroKeypointSmoother(PARAMS);
    let lag = Infinity;
    for (let i = 0; i < 20; i++) {
      const x = 100 + i * 40;
      const out = f.apply([kp('nose', x, 300)], 1000 + i * TICK_MS, FRAME_WIDTH);
      lag = x - out[0].x;
    }
    expect(lag).toBeLessThan(70);
  });

  it('restarts tracking after a long gap instead of smoothing against stale state', () => {
    const f = new OneEuroKeypointSmoother(PARAMS);
    f.apply([kp('nose', 100, 100)], 1000, FRAME_WIDTH);
    // >1s later, far away: must pass through, not drag toward the old spot.
    const out = f.apply([kp('nose', 900, 700)], 3000, FRAME_WIDTH);
    expect(out[0].x).toBe(900);
    expect(out[0].y).toBe(700);
  });

  it('survives a zero timestamp delta without NaN', () => {
    const f = new OneEuroKeypointSmoother(PARAMS);
    f.apply([kp('nose', 100, 100)], 1000, FRAME_WIDTH);
    const out = f.apply([kp('nose', 110, 100)], 1000, FRAME_WIDTH);
    expect(Number.isFinite(out[0].x)).toBe(true);
    expect(Number.isFinite(out[0].y)).toBe(true);
  });

  it('reset() clears state so the next frame passes through', () => {
    const f = new OneEuroKeypointSmoother(PARAMS);
    f.apply([kp('nose', 100, 100)], 1000, FRAME_WIDTH);
    f.reset();
    const out = f.apply([kp('nose', 500, 500)], 1100, FRAME_WIDTH);
    expect(out[0].x).toBe(500);
  });
});
