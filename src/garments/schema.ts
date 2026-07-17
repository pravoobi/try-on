/**
 * Garment catalog data model (see CLAUDE.md "Garment data model") and runtime
 * validation for catalog.json — the JSON has no compile-time guarantee, and
 * a malformed anchor set fails silently downstream in the TPS warp.
 *
 * Most garments are a single image + one 6-anchor set. A lehenga-choli is
 * two independently-photographed pieces (choli/top, lehenga/skirt) that get
 * warped and composited separately — see CLAUDE.md's garment difficulty
 * order ("treat as two garments... composite both") — so `Garment` is a
 * discriminated union on `category` rather than one flat shape.
 */
import {
  ANCHOR_NAMES,
  SKIRT_ANCHOR_NAMES,
  SLEEVE_ANCHOR_NAMES,
  type AnchorName,
  type GarmentAnchors,
  type HemLength,
  type SkirtAnchorName,
  type SkirtAnchors,
} from '@practics/tryon-core';

export const GARMENT_CATEGORIES = ['kurti', 'dress', 'top', 'shirt', 'tshirt', 'pants', 'lehenga-choli', 'saree'] as const;
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

/** Categories using the standard 6-anchor top pipeline (shoulders/waist/hem) as a single image. */
export type TopLikeCategory = Exclude<GarmentCategory, 'lehenga-choli' | 'pants'>;

export const SLEEVE_LENGTHS = ['full', 'half', 'sleeveless'] as const;
export type SleeveLength = (typeof SLEEVE_LENGTHS)[number];

export const HEM_LENGTHS = ['hip', 'knee', 'ankle'] as const satisfies readonly HemLength[];

export interface GarmentMeta {
  sleeves: SleeveLength;
  length: HemLength;
}

/** A single-image garment piece using the full 6-anchor set (shoulder/waist/hem). */
export interface GarmentPiece {
  image: string;
  anchors: GarmentAnchors;
}

/** The skirt half of a lehenga-choli — waist/hem only, no shoulders. */
export interface LehengaSkirtPiece {
  image: string;
  anchors: SkirtAnchors;
}

export interface SinglePieceGarment {
  id: string;
  category: TopLikeCategory;
  image: string;
  anchors: GarmentAnchors;
  /**
   * Optional back-view photo (Phase A4 user uploads; see
   * docs/plan-3d-garment-assets.md §5.1). A garment's back is rendered only
   * when this is present — never fabricated by mirroring the front (prints,
   * necklines, and closures differ front-to-back).
   */
  back?: GarmentPiece;
  meta: GarmentMeta;
}

export interface LehengaCholiGarment {
  id: string;
  category: 'lehenga-choli';
  choli: GarmentPiece;
  /** meta.length describes the LEHENGA's hem (knee/ankle) — the choli's own hem is always the natural waistline. */
  lehenga: LehengaSkirtPiece;
  meta: GarmentMeta;
}

/**
 * Pants/shorts — a lower-body, leg-tracking garment. Uses the 4-point
 * skirt anchor shape (waistL/R + hemL/R), but the hem anchors mark the
 * OUTER BOTTOM CORNER OF EACH LEG in the garment image, mapped at runtime
 * to the wearer's per-leg knee/ankle keypoints (tryon-core's
 * computePantsBodyAnchors). meta.length: knee = shorts, ankle =
 * full-length; 'hip' is rejected — hip-length pants aren't a garment.
 * meta.sleeves is meaningless for pants and pinned to 'sleeveless'.
 */
export interface PantsGarment {
  id: string;
  category: 'pants';
  image: string;
  anchors: SkirtAnchors;
  meta: GarmentMeta;
}

export type Garment = SinglePieceGarment | LehengaCholiGarment | PantsGarment;

class GarmentValidationError extends Error {}

function fail(path: string, detail: string): never {
  throw new GarmentValidationError(`garment${path}: ${detail}`);
}

function isPoint(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  );
}

function validateAnchorSet<Name extends string>(
  v: unknown,
  names: readonly Name[],
  path: string,
): Record<Name, [number, number]> {
  if (typeof v !== 'object' || v === null) fail(path, 'anchors must be an object');
  const obj = v as Record<string, unknown>;
  const out: Partial<Record<Name, [number, number]>> = {};
  for (const name of names) {
    const point = obj[name];
    if (!isPoint(point)) {
      fail(path, `anchors.${name} must be a [x, y] tuple of finite numbers`);
    }
    out[name] = point;
  }
  return out as Record<Name, [number, number]>;
}

function validateAnchors(v: unknown, path: string): GarmentAnchors {
  const anchors: GarmentAnchors = validateAnchorSet<AnchorName>(v, ANCHOR_NAMES, path);
  // Optional sleeve anchors (see tryon-core SLEEVE_ANCHOR_NAMES): absent is
  // fine (sleeves stay in the photo pose), but a present-yet-malformed one
  // should fail loudly like any other anchor.
  const obj = v as Record<string, unknown>;
  for (const name of SLEEVE_ANCHOR_NAMES) {
    if (obj[name] === undefined) continue;
    if (!isPoint(obj[name])) fail(path, `anchors.${name} must be a [x, y] tuple of finite numbers`);
    anchors[name] = obj[name];
  }
  return anchors;
}

function validateSkirtAnchors(v: unknown, path: string): SkirtAnchors {
  return validateAnchorSet<SkirtAnchorName>(v, SKIRT_ANCHOR_NAMES, path);
}

function validateMeta(v: unknown, path: string): GarmentMeta {
  if (typeof v !== 'object' || v === null) fail(path, 'meta must be an object');
  const obj = v as Record<string, unknown>;
  if (!SLEEVE_LENGTHS.includes(obj.sleeves as SleeveLength)) {
    fail(path, `meta.sleeves must be one of ${SLEEVE_LENGTHS.join(', ')}`);
  }
  if (!HEM_LENGTHS.includes(obj.length as HemLength)) {
    fail(path, `meta.length must be one of ${HEM_LENGTHS.join(', ')}`);
  }
  return { sleeves: obj.sleeves as SleeveLength, length: obj.length as HemLength };
}

function validateImagePath(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(path, 'image must be a non-empty string');
  return v;
}

function validatePiece(v: unknown, path: string): GarmentPiece {
  if (typeof v !== 'object' || v === null) fail(path, 'must be an object');
  const obj = v as Record<string, unknown>;
  return {
    image: validateImagePath(obj.image, `${path}.image`),
    anchors: validateAnchors(obj.anchors, `${path}.anchors`),
  };
}

function validateSkirtPiece(v: unknown, path: string): LehengaSkirtPiece {
  if (typeof v !== 'object' || v === null) fail(path, 'must be an object');
  const obj = v as Record<string, unknown>;
  return {
    image: validateImagePath(obj.image, `${path}.image`),
    anchors: validateSkirtAnchors(obj.anchors, `${path}.anchors`),
  };
}

/** Validates one garment record, throwing a descriptive error if malformed. */
export function validateGarment(data: unknown, index?: number): Garment {
  const path = index !== undefined ? `[${index}]` : '';
  if (typeof data !== 'object' || data === null) fail(path, 'must be an object');
  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.length === 0) fail(path, 'id must be a non-empty string');
  if (!GARMENT_CATEGORIES.includes(obj.category as GarmentCategory)) {
    fail(path, `category must be one of ${GARMENT_CATEGORIES.join(', ')}`);
  }
  const meta = validateMeta(obj.meta, `${path}.meta`);

  if (obj.category === 'lehenga-choli') {
    return {
      id: obj.id,
      category: 'lehenga-choli',
      choli: validatePiece(obj.choli, `${path}.choli`),
      lehenga: validateSkirtPiece(obj.lehenga, `${path}.lehenga`),
      meta,
    };
  }

  if (obj.category === 'pants') {
    if (meta.length === 'hip') fail(path, "pants meta.length must be 'knee' (shorts) or 'ankle' (full-length)");
    return {
      id: obj.id,
      category: 'pants',
      image: validateImagePath(obj.image, `${path}.image`),
      anchors: validateSkirtAnchors(obj.anchors, `${path}.anchors`),
      meta,
    };
  }

  return {
    id: obj.id,
    category: obj.category as TopLikeCategory,
    image: validateImagePath(obj.image, `${path}.image`),
    anchors: validateAnchors(obj.anchors, `${path}.anchors`),
    ...(obj.back !== undefined ? { back: validatePiece(obj.back, `${path}.back`) } : {}),
    meta,
  };
}

/** Validates a full catalog.json array. */
export function validateCatalog(data: unknown): Garment[] {
  if (!Array.isArray(data)) throw new GarmentValidationError('catalog must be an array');
  const ids = new Set<string>();
  return data.map((entry, i) => {
    const garment = validateGarment(entry, i);
    if (ids.has(garment.id)) fail(`[${i}]`, `duplicate garment id "${garment.id}"`);
    ids.add(garment.id);
    return garment;
  });
}
