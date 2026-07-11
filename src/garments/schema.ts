/**
 * Garment catalog data model (see CLAUDE.md "Garment data model") and runtime
 * validation for catalog.json — the JSON has no compile-time guarantee, and
 * a malformed anchor set fails silently downstream in the TPS warp.
 */
import { ANCHOR_NAMES, type AnchorName, type GarmentAnchors, type HemLength } from '../pipeline/types';

export const GARMENT_CATEGORIES = ['kurti', 'dress', 'top', 'lehenga', 'saree'] as const;
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number];

export const SLEEVE_LENGTHS = ['full', 'half', 'sleeveless'] as const;
export type SleeveLength = (typeof SLEEVE_LENGTHS)[number];

export const HEM_LENGTHS = ['hip', 'knee', 'ankle'] as const satisfies readonly HemLength[];

export interface GarmentMeta {
  sleeves: SleeveLength;
  length: HemLength;
}

export interface Garment {
  id: string;
  category: GarmentCategory;
  image: string;
  anchors: GarmentAnchors;
  meta: GarmentMeta;
}

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

function validateAnchors(v: unknown, path: string): GarmentAnchors {
  if (typeof v !== 'object' || v === null) fail(path, 'anchors must be an object');
  const obj = v as Record<string, unknown>;
  const out: Partial<Record<AnchorName, [number, number]>> = {};
  for (const name of ANCHOR_NAMES) {
    const point = obj[name];
    if (!isPoint(point)) {
      fail(path, `anchors.${name} must be a [x, y] tuple of finite numbers`);
    }
    out[name] = point;
  }
  return out as GarmentAnchors;
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

/** Validates one garment record, throwing a descriptive error if malformed. */
export function validateGarment(data: unknown, index?: number): Garment {
  const path = index !== undefined ? `[${index}]` : '';
  if (typeof data !== 'object' || data === null) fail(path, 'must be an object');
  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.length === 0) fail(path, 'id must be a non-empty string');
  if (!GARMENT_CATEGORIES.includes(obj.category as GarmentCategory)) {
    fail(path, `category must be one of ${GARMENT_CATEGORIES.join(', ')}`);
  }
  if (typeof obj.image !== 'string' || obj.image.length === 0) {
    fail(path, 'image must be a non-empty string');
  }

  return {
    id: obj.id,
    category: obj.category as GarmentCategory,
    image: obj.image,
    anchors: validateAnchors(obj.anchors, `${path}.anchors`),
    meta: validateMeta(obj.meta, `${path}.meta`),
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
