import { describe, expect, it } from 'vitest';
import { smoothKeypoints } from './smoothing';
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
