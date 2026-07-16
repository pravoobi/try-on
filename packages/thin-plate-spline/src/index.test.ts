import { describe, expect, it } from 'vitest';
import { ThinPlateSpline, type Point } from './index';

const NON_COLLINEAR: Point[] = [
  [0, 0],
  [10, 0],
  [0, 10],
  [10, 10],
  [5, 5],
  [3, 8],
];

function expectClose(p: Point, q: Point) {
  expect(p[0]).toBeCloseTo(q[0], 6);
  expect(p[1]).toBeCloseTo(q[1], 6);
}

describe('ThinPlateSpline — affine reduction property', () => {
  // When dst_i = A(src_i) for an affine map A, the unique TPS solution has
  // zero non-affine warp and reduces exactly to A everywhere, not just at
  // the control points. This is the standard correctness check for a TPS
  // implementation (also exercises the control-point interpolation itself).

  it('reduces to the identity when src == dst', () => {
    const tps = new ThinPlateSpline(NON_COLLINEAR, NON_COLLINEAR);
    for (const p of NON_COLLINEAR) expectClose(tps.eval(p), p);
    // Also holds off the control points (identity is affine).
    expectClose(tps.eval([2, 7]), [2, 7]);
    expectClose(tps.eval([-4, 12]), [-4, 12]);
  });

  it('reduces to a uniform translation', () => {
    const t: Point = [10, -20];
    const dst = NON_COLLINEAR.map((p) => [p[0] + t[0], p[1] + t[1]] as Point);
    const tps = new ThinPlateSpline(NON_COLLINEAR, dst);
    for (const p of NON_COLLINEAR) {
      expectClose(tps.eval(p), [p[0] + t[0], p[1] + t[1]]);
    }
    expectClose(tps.eval([100, 50]), [110, 30]);
  });

  it('reduces to a uniform scale about the origin', () => {
    const s = 2.5;
    const dst = NON_COLLINEAR.map((p) => [p[0] * s, p[1] * s] as Point);
    const tps = new ThinPlateSpline(NON_COLLINEAR, dst);
    expectClose(tps.eval([4, -6]), [4 * s, -6 * s]);
  });

  it('reduces to a general affine map (rotation + shear + translate)', () => {
    // A(p) = [2p.x + 0.5p.y + 3, -0.3p.x + 1.2p.y - 4]
    const A = (p: Point): Point => [2 * p[0] + 0.5 * p[1] + 3, -0.3 * p[0] + 1.2 * p[1] - 4];
    const dst = NON_COLLINEAR.map(A);
    const tps = new ThinPlateSpline(NON_COLLINEAR, dst);
    for (const p of [
      [1, 1],
      [-5, 20],
      [50, -50],
    ] as Point[]) {
      expectClose(tps.eval(p), A(p));
    }
  });
});

describe('ThinPlateSpline — non-affine (genuine warp) case', () => {
  it('interpolates exactly at control points for a non-affine displacement', () => {
    // Push just one control point, leaving the rest fixed — a genuinely
    // nonlinear target that cannot be represented by any single affine map.
    const dst = NON_COLLINEAR.map((p) => p);
    const dstMut = dst.slice();
    dstMut[4] = [dst[4][0] + 3, dst[4][1] - 7]; // displace the interior point [5,5]
    const tps = new ThinPlateSpline(NON_COLLINEAR, dstMut);
    for (let i = 0; i < NON_COLLINEAR.length; i++) {
      expectClose(tps.eval(NON_COLLINEAR[i]), dstMut[i]);
    }
  });

  it('throws on fewer than 3 control points', () => {
    expect(() => new ThinPlateSpline([[0, 0], [1, 1]], [[0, 0], [1, 1]])).toThrow(/at least 3/);
  });

  it('throws on mismatched src/dst lengths', () => {
    expect(() => new ThinPlateSpline(NON_COLLINEAR, NON_COLLINEAR.slice(0, 3))).toThrow(/length mismatch/);
  });

  it('throws on collinear control points (singular system)', () => {
    const collinear: Point[] = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    expect(() => new ThinPlateSpline(collinear, collinear)).toThrow(/singular/);
  });
});
