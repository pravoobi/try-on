/**
 * Maps detected body keypoints to the body-space anchor targets a garment's
 * TPS warp is fit to (see CLAUDE.md "Garment data model" — shoulders direct,
 * waist interpolated shoulder→hip, hem extrapolated below hips per
 * meta.length). Also covers the lehenga-choli case: the skirt's waistband
 * shares the exact hip-line point the choli's own hem would use, so the two
 * independently-warped pieces meet with no gap.
 */
import type { TryOnConfig } from './config.js';
import {
  ANCHOR_NAMES,
  SLEEVE_ANCHOR_NAMES,
  type BodyAnchors,
  type GarmentAnchors,
  type HemFlare,
  type HemLength,
  type Keypoint,
  type KeypointName,
  type Point,
  type SkirtAnchors,
  type SleeveLength,
} from './types.js';

function findKeypoint(keypoints: readonly Keypoint[], name: KeypointName): Keypoint | undefined {
  return keypoints.find((k) => k.name === name);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Pushes two points apart from their shared midpoint by `scale`. */
function scalePairOutward(a: Point, b: Point, scale: number): [Point, Point] {
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  return [
    [cx + (a[0] - cx) * scale, cy + (a[1] - cy) * scale],
    [cx + (b[0] - cx) * scale, cy + (b[1] - cy) * scale],
  ];
}

const HEM_KEYPOINTS: Record<HemLength, readonly [KeypointName, KeypointName] | null> = {
  hip: null,
  knee: ['left_knee', 'right_knee'],
  ankle: ['left_ankle', 'right_ankle'],
};

/** Leg keypoints a hem of this length hangs over — every joint between the hips and the hem line, since fabric must clear all of them. */
const STANCE_KEYPOINTS: Record<HemLength, readonly KeypointName[]> = {
  hip: [],
  knee: ['left_knee', 'right_knee'],
  ankle: ['left_knee', 'right_knee', 'left_ankle', 'right_ankle'],
};

interface TorsoContext {
  shoulderL: Point;
  shoulderR: Point;
  hipL: Point;
  hipR: Point;
  torsoHeight: number;
}

/**
 * Shared confidence gate + torso measurements used by every anchor-target
 * computation. Returns null if the torso isn't confidently visible enough
 * to anchor a garment (e.g. back-facing, heavily occluded, non-person photo).
 */
function computeTorsoContext(keypoints: readonly Keypoint[], config: TryOnConfig): TorsoContext | null {
  const ls = findKeypoint(keypoints, 'left_shoulder');
  const rs = findKeypoint(keypoints, 'right_shoulder');
  const lh = findKeypoint(keypoints, 'left_hip');
  const rh = findKeypoint(keypoints, 'right_hip');
  const minScore = config.minKeypointScore;
  if (
    !ls ||
    !rs ||
    !lh ||
    !rh ||
    ls.score < minScore ||
    rs.score < minScore ||
    lh.score < minScore ||
    rh.score < minScore
  ) {
    return null;
  }

  const torsoHeight = Math.abs((lh.y + rh.y) / 2 - (ls.y + rs.y) / 2);

  // Keypoints sit at skeletal joints, well inside the clothed silhouette —
  // anchoring fabric to the raw joints leaves skin strips at the shoulders
  // and hips. Widen the targets to the body's visual edges and lift the
  // shoulder targets to the top of the shoulder (the joint center is below
  // the seam line). Overflow past the silhouette is clipped to the person
  // mask downstream, so erring wide is safe.
  const lift = torsoHeight * config.anchors.shoulderLift;
  const [shoulderL, shoulderR] = scalePairOutward(
    [ls.x, ls.y - lift],
    [rs.x, rs.y - lift],
    config.anchors.widthScale.shoulder,
  );
  const [hipL, hipR] = scalePairOutward([lh.x, lh.y], [rh.x, rh.y], config.anchors.widthScale.hip);

  return { shoulderL, shoulderR, hipL, hipR, torsoHeight };
}

/** Returns the [leftY, rightY] a hem/skirt-bottom should sit at, per the
 * knee/ankle keypoint if confidently visible, else a hip-relative fallback. */
function computeHemY(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  ctx: TorsoContext,
  config: TryOnConfig,
): [number, number] {
  const pair = HEM_KEYPOINTS[hemLength];
  if (pair) {
    const l = findKeypoint(keypoints, pair[0]);
    const r = findKeypoint(keypoints, pair[1]);
    if (l && r && l.score >= config.minKeypointScore && r.score >= config.minKeypointScore) {
      return [l.y, r.y];
    }
  }
  const dy = ctx.torsoHeight * config.anchors.hemFallbackMultiplier[hemLength];
  return [ctx.hipL[1] + dy, ctx.hipR[1] + dy];
}

function computeHem(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  ctx: TorsoContext,
  config: TryOnConfig,
): [Point, Point] {
  // x pinned exactly at the hips — used for the lehenga skirt's waistband,
  // which must sit at the same hip-line points the choli's hem uses so the
  // two pieces meet with no gap. Garment hems themselves get a flare
  // instead (computeFlaredHem): even a "fitted" knee/ankle hem hangs a bit
  // wider than the hips, or a wide-stance leg pokes out beside the fabric.
  const [ly, ry] = computeHemY(keypoints, hemLength, ctx, config);
  return [
    [ctx.hipL[0], ly],
    [ctx.hipR[0], ry],
  ];
}

/**
 * Like computeHem, but flares the hem outward from the hips by `flare` (a
 * multiple of the hip half-width) — a lehenga skirt's hem is dramatically
 * wider than its waistband (config.anchors.skirtFlare), and even a fitted
 * knee/ankle dress hangs slightly wider than the hips
 * (config.anchors.dressFlare), otherwise a wide-stance leg pokes out
 * beside the fabric. Collapsing a wide garment image's hem to hip-width
 * mismatches its own flare badly enough that the TPS warp folds over
 * itself.
 */
function computeFlaredHem(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  ctx: TorsoContext,
  flare: number,
  topL: Point,
  topR: Point,
  config: TryOnConfig,
): [Point, Point] {
  const [ly, ry] = computeHemY(keypoints, hemLength, ctx, config);
  const centerX = (ctx.hipL[0] + ctx.hipR[0]) / 2;
  const hipHalfWidth = Math.abs(ctx.hipR[0] - ctx.hipL[0]) / 2;
  let halfWidth = hipHalfWidth * flare;

  // The hem also has to clear the wearer's stance: fabric hangs *over* the
  // legs, so a wide-stance leg must never poke out beside the fabric. The
  // warped fabric edge runs (near-)straight from the garment's top anchor
  // on that side (`topL`/`topR` — the waist for a dress, the waistband for
  // a lehenga skirt) down to the hem anchor, so clearing a leg joint at
  // height-fraction t along that edge is a constraint on the HEM width
  // scaled by 1/t — naively widening the hem to the joint's own x still
  // lets the edge cut across the thigh/knee higher up. The hip silhouette
  // points anchor the top of each leg, so including them makes the
  // straight edge clear the whole (straight) thigh, not just the joints
  // below it.
  const stanceJoints = STANCE_KEYPOINTS[hemLength];
  if (stanceJoints.length > 0) {
    const topY = (topL[1] + topR[1]) / 2;
    const topHalfWidth = Math.abs(topR[0] - topL[0]) / 2;
    const hemYMid = (ly + ry) / 2;
    const span = Math.max(1, hemYMid - topY);
    const margin = hipHalfWidth * config.anchors.stanceCoverMargin;
    const flareHalfWidth = halfWidth;

    // [need, yAt, weight] — weight fades a joint's constraint in over a
    // confidence band above the threshold instead of a hard on/off: a
    // knee/ankle score hovering at the cutoff would otherwise pop the hem
    // width (and the whole skirt silhouette) frame to frame in live mode.
    const constraints: Array<readonly [number, number, number]> = [
      [Math.abs(ctx.hipL[0] - centerX), (ctx.hipL[1] + ctx.hipR[1]) / 2, 1],
      [Math.abs(ctx.hipR[0] - centerX), (ctx.hipL[1] + ctx.hipR[1]) / 2, 1],
    ];
    for (const name of stanceJoints) {
      const kp = findKeypoint(keypoints, name);
      if (kp && kp.score >= config.minKeypointScore) {
        const weight = Math.min(1, (kp.score - config.minKeypointScore) / config.anchors.stanceScoreSoftBand);
        constraints.push([Math.abs(kp.x - centerX) + margin, kp.y, weight]);
      }
    }

    for (const [need, yAt, weight] of constraints) {
      const t = Math.min(1, (yAt - topY) / span);
      if (t <= 0.1) continue; // at/above the top anchor — not the hem edge's problem
      const required = topHalfWidth + (need - topHalfWidth) / t;
      halfWidth = Math.max(halfWidth, flareHalfWidth + (required - flareHalfWidth) * weight);
    }
    // Keypoint glitches (an ankle detected way off-body) shouldn't produce
    // a tent — cap the stance-driven widening.
    halfWidth = Math.min(halfWidth, hipHalfWidth * 3);
  }

  const sign = Math.sign(ctx.hipL[0] - ctx.hipR[0]) || 1;
  return [
    [centerX + sign * halfWidth, ly],
    [centerX - sign * halfWidth, ry],
  ];
}

/**
 * cos of the angle between the upper arm and the forearm, 1 = perfectly
 * straight, 0 = a right angle, negative = folded back on itself. Returns
 * null when either segment is degenerate.
 */
function armStraightness(shoulder: Keypoint, elbow: Keypoint, wrist: Keypoint): number | null {
  const ux = elbow.x - shoulder.x;
  const uy = elbow.y - shoulder.y;
  const fx = wrist.x - elbow.x;
  const fy = wrist.y - elbow.y;
  const ul = Math.hypot(ux, uy);
  const fl = Math.hypot(fx, fy);
  if (ul < 1e-3 || fl < 1e-3) return null;
  return (ux * fx + uy * fy) / (ul * fl);
}

/**
 * Sleeve anchor targets for one arm (see types.ts SLEEVE_ANCHOR_NAMES): the
 * sleeve's midline follows the arm's own joint centers — no outward
 * widening, unlike torso anchors, since a sleeve wraps the arm rather than
 * draping in front of it. Each target is emitted only when the joints it
 * needs are confidently tracked; a missing target simply omits that TPS
 * correspondence, so the sleeve degrades to today's photo-pose behavior
 * rather than snapping to a garbage keypoint.
 *
 * A BENT arm emits nothing at all (see config.anchors.sleeve.minStraightness).
 * The garment photo shows a straight, hanging sleeve, and a thin-plate
 * spline is a single globally-smooth surface: asking it to send that
 * straight sleeve's far-edge cuff to a wrist that has folded back toward
 * the body — a hand on a hip — is a large, sharply-varying displacement,
 * and TPS pays for it by bending everything nearby. Observed on a
 * hand-on-hip photo as the kurti's bust pinching inward and the sleeve
 * tearing off as a floating strip. The fabric would have to fold at the
 * elbow to do this honestly, which a 2D warp of a flat photo cannot
 * represent, so the correct answer is to decline: fall back to the
 * torso-only anchors, exactly as before sleeve support existed.
 */
function computeSleeveTargets(
  keypoints: readonly Keypoint[],
  side: 'left' | 'right',
  sleeves: SleeveLength,
  config: TryOnConfig,
): { elbow?: Point; cuff?: Point } {
  if (sleeves === 'sleeveless') return {};
  const minScore = config.minKeypointScore;
  const shoulder = findKeypoint(keypoints, `${side}_shoulder`);
  const elbow = findKeypoint(keypoints, `${side}_elbow`);
  if (!elbow || elbow.score < minScore) return {};

  if (sleeves === 'half') {
    if (!shoulder || shoulder.score < minScore) return {};
    // A half sleeve ends mid-upper-arm, so only the shoulder→elbow segment
    // matters — a bent forearm doesn't affect it and isn't checked.
    const t = config.anchors.sleeve.halfCuffT;
    // Raw shoulder joint (not the widened/lifted torso anchor) — the sleeve
    // runs down the arm's own centerline.
    return { cuff: [lerp(shoulder.x, elbow.x, t), lerp(shoulder.y, elbow.y, t)] };
  }

  const wrist = findKeypoint(keypoints, `${side}_wrist`);
  if (!wrist || wrist.score < minScore || !shoulder || shoulder.score < minScore) {
    // No usable forearm to check for bend: pin the elbow only, which stays
    // near where a hanging arm's elbow sits and so displaces little.
    return { elbow: [elbow.x, elbow.y] };
  }

  const straightness = armStraightness(shoulder, elbow, wrist);
  if (straightness !== null && straightness < config.anchors.sleeve.minStraightness) {
    return {};
  }

  const t = config.anchors.sleeve.fullCuffT;
  return {
    elbow: [elbow.x, elbow.y],
    cuff: [lerp(elbow.x, wrist.x, t), lerp(elbow.y, wrist.y, t)],
  };
}

/**
 * Computes the 6 body-space anchor targets, or null if the torso isn't
 * confidently visible enough to anchor a garment. When `sleeves` is given
 * (and not 'sleeveless'), also emits the optional per-arm sleeve targets a
 * sleeve-annotated garment can pair with (see anchorCorrespondences).
 */
export function computeBodyAnchors(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  config: TryOnConfig,
  sleeves?: SleeveLength,
  hemFlare: HemFlare = 'dress',
): BodyAnchors | null {
  const ctx = computeTorsoContext(keypoints, config);
  if (!ctx) return null;

  const t = config.anchors.waistT;
  const waistL: Point = [lerp(ctx.shoulderL[0], ctx.hipL[0], t), lerp(ctx.shoulderL[1], ctx.hipL[1], t)];
  const waistR: Point = [lerp(ctx.shoulderR[0], ctx.hipR[0], t), lerp(ctx.shoulderR[1], ctx.hipR[1], t)];

  const flareTable = hemFlare === 'skirt' ? config.anchors.skirtFlare : config.anchors.dressFlare;
  const [hemL, hemR] = computeFlaredHem(
    keypoints,
    hemLength,
    ctx,
    flareTable[hemLength],
    waistL,
    waistR,
    config,
  );

  const anchors: BodyAnchors = { shoulderL: ctx.shoulderL, shoulderR: ctx.shoulderR, waistL, waistR, hemL, hemR };
  if (sleeves) {
    const left = computeSleeveTargets(keypoints, 'left', sleeves, config);
    const right = computeSleeveTargets(keypoints, 'right', sleeves, config);
    if (left.elbow) anchors.elbowL = left.elbow;
    if (left.cuff) anchors.cuffL = left.cuff;
    if (right.elbow) anchors.elbowR = right.elbow;
    if (right.cuff) anchors.cuffR = right.cuff;
  }
  return anchors;
}

/**
 * Builds the TPS correspondence lists for a top-like garment: the 6
 * required anchors always, plus each optional sleeve anchor present on
 * BOTH sides of the mapping (annotated on the garment AND confidently
 * computed on the body). Pairing is strictly by name — a garment cuff with
 * no body cuff target (arm not tracked) contributes nothing.
 */
/**
 * Where along shoulder→elbow the synthesized sleeve-cap pin sits (see
 * anchorCorrespondences): high enough to hold the sleeve cap at the
 * shoulder, low enough that the sleeve's rotation toward the tracked arm
 * happens below it.
 */
const SLEEVE_CAP_PIN_T = 0.35;

function lerpPoint(a: Point, b: Point, t: number): Point {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

export function anchorCorrespondences(
  garment: GarmentAnchors,
  body: BodyAnchors,
): { src: Point[]; dst: Point[] } {
  const src: Point[] = ANCHOR_NAMES.map((n) => garment[n]);
  const dst: Point[] = ANCHOR_NAMES.map((n) => body[n]);
  for (const n of SLEEVE_ANCHOR_NAMES) {
    const g = garment[n];
    const b = body[n];
    if (g && b) {
      src.push(g);
      dst.push(b);
    }
  }
  // Sleeve-cap pin: with only shoulder + elbow correspondences, a sleeve
  // rotating from the photo pose toward the tracked arm smears that
  // rotation up through the shoulder — the cap slides inward and opens a
  // skin gap at the shoulder silhouette (seen as an accidental
  // "cold-shoulder" cut). A synthesized pair partway down the upper sleeve
  // pins the cap fabric to the upper arm, so the bend happens below it.
  const capPin = (shoulder: 'shoulderL' | 'shoulderR', elbow: 'elbowL' | 'elbowR') => {
    const gElbow = garment[elbow];
    const bElbow = body[elbow];
    if (!gElbow || !bElbow) return;
    src.push(lerpPoint(garment[shoulder], gElbow, SLEEVE_CAP_PIN_T));
    dst.push(lerpPoint(body[shoulder], bElbow, SLEEVE_CAP_PIN_T));
  };
  capPin('shoulderL', 'elbowL');
  capPin('shoulderR', 'elbowR');
  return { src, dst };
}

/**
 * Computes the lehenga skirt's body-space anchor targets (waist + hem only).
 * The waistband is exactly the point computeBodyAnchors(keypoints, 'hip')
 * would use as the choli's own hem — that shared point is what makes the
 * two independently-warped pieces meet with no visible seam gap.
 */
export function computeLehengaSkirtBodyAnchors(
  keypoints: readonly Keypoint[],
  skirtLength: HemLength,
  config: TryOnConfig,
): SkirtAnchors | null {
  const ctx = computeTorsoContext(keypoints, config);
  if (!ctx) return null;

  const [waistL, waistR] = computeHem(keypoints, 'hip', ctx, config);
  const [hemL, hemR] = computeFlaredHem(
    keypoints,
    skirtLength,
    ctx,
    config.anchors.skirtFlare[skirtLength],
    waistL,
    waistR,
    config,
  );

  return { waistL, waistR, hemL, hemR };
}

/**
 * Computes pants body-space anchor targets (waistband + per-leg hem), or
 * null if the torso isn't confidently visible. Reuses the SkirtAnchors
 * shape (waistL/R + hemL/R), but the hem semantics differ from a skirt's:
 * a skirt hem is ONE straight fabric edge flared wide enough to clear both
 * legs, while pants hems track EACH leg separately — hemL pins the outer
 * corner of the left pant leg just outside the left knee/ankle keypoint,
 * hemR the right. The inner-leg edges carry no anchors; the TPS
 * interpolates them and the person-mask clip (pants are fitted, unlike a
 * free-hanging skirt) snaps the fabric to the leg silhouette.
 *
 * The waistband shares the exact hip-line points a lehenga waistband / a
 * hip-length top's hem would use, so a future top+pants outfit meets with
 * no gap. meta.length semantics: knee = shorts, ankle = full-length;
 * 'hip' is not meaningful for pants (validated upstream in the app schema).
 */
export function computePantsBodyAnchors(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  config: TryOnConfig,
): SkirtAnchors | null {
  const ctx = computeTorsoContext(keypoints, config);
  if (!ctx) return null;

  const [waistL, waistR] = computeHem(keypoints, 'hip', ctx, config);
  const centerX = (ctx.hipL[0] + ctx.hipR[0]) / 2;
  const hipHalfWidth = Math.abs(ctx.hipR[0] - ctx.hipL[0]) / 2;
  // Same outward margin the skirt stance cover uses: the joint keypoint is
  // the leg's CENTER line, and the pant leg's outer corner must clear the
  // leg's own visual edge.
  const margin = hipHalfWidth * config.anchors.stanceCoverMargin;
  const signL = Math.sign(ctx.hipL[0] - centerX) || -1;
  const signR = -signL;

  const [fallbackLy, fallbackRy] = computeHemY(keypoints, hemLength, ctx, config);
  const pair = HEM_KEYPOINTS[hemLength];
  const legFor = (name: KeypointName | undefined, waistX: number, fallbackY: number): Point => {
    const kp = name ? findKeypoint(keypoints, name) : undefined;
    if (kp && kp.score >= config.minKeypointScore) return [kp.x, kp.y];
    // Leg not confidently tracked: hang the hem straight down from the
    // waistband corner (legs sit under the hips in any anchorable pose).
    return [waistX, fallbackY];
  };
  const legL = legFor(pair?.[0], waistL[0], fallbackLy);
  const legR = legFor(pair?.[1], waistR[0], fallbackRy);

  return {
    waistL,
    waistR,
    hemL: [legL[0] + signL * margin, legL[1]],
    hemR: [legR[0] + signR * margin, legR[1]],
  };
}

const MIRROR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['shoulderL', 'shoulderR'],
  ['waistL', 'waistR'],
  ['hemL', 'hemR'],
  ['elbowL', 'elbowR'],
  ['cuffL', 'cuffR'],
];

/**
 * Swaps L/R-named anchors (Phase A5, see docs/plan-3d-garment-assets.md
 * §5.4.3) — used when warping a garment's *back* photo onto the body: the
 * back image's own left/right (image-space, same convention as the front —
 * see pipeline/autoAnchor.ts) is annotated independently, but the person's
 * shoulder that anchors the front image's left side anchors the back
 * image's *right* side once you're looking at them from behind.
 */
export function mirrorAnchorsLR<T extends Partial<Record<string, Point>>>(anchors: T): T {
  const out = { ...anchors };
  for (const [a, b] of MIRROR_PAIRS) {
    if (anchors[a] && anchors[b]) {
      (out as Record<string, Point>)[a] = anchors[b]!;
      (out as Record<string, Point>)[b] = anchors[a]!;
    }
  }
  return out;
}

/**
 * Horizontally compresses an anchor set toward its own centroid x by
 * `factor` (1 = no change) — a cheap stand-in for a full 3D pre-rotation,
 * approximating the foreshortening a torso rotated |yaw| degrees from the
 * camera would show (Phase A5, see docs/plan-3d-garment-assets.md §5.4.3
 * and pipeline/orientation.ts's foreshortenFactor). y is untouched — only
 * yaw (rotation about the vertical spine axis) is modeled, not pitch/roll.
 */
export function foreshortenAnchors<T extends Partial<Record<string, Point>>>(anchors: T, factor: number): T {
  const points = Object.values(anchors).filter((p): p is Point => !!p);
  const centerX = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const out = { ...anchors } as Record<string, Point>;
  for (const key of Object.keys(anchors)) {
    const point = anchors[key as keyof T] as Point | undefined;
    if (!point) continue;
    out[key] = [centerX + (point[0] - centerX) * factor, point[1]];
  }
  return out as T;
}
