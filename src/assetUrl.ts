/**
 * Resolves a root-relative asset path (e.g. "/models/x.tflite") against
 * Vite's configured base path. Needed because GitHub Pages serves this repo
 * from /try-on/, not the domain root (see vite.config.ts) — a hardcoded
 * leading-slash path in a fetch() call or <img src> is NOT rewritten by
 * Vite's `base` option (that only applies to assets Vite itself processes),
 * so every runtime path built from config.ts/catalog.json must go through
 * this before use.
 *
 * Already-absolute URLs (blob:, data:, http(s):) pass through untouched —
 * user-uploaded garments (Phase A4) are stored as Blobs and referenced by
 * `blob:` object URL rather than a server path, so they flow through the
 * exact same fetch()/<img src> code paths as catalog garments with no
 * further special-casing.
 */
export function assetUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return import.meta.env.BASE_URL.replace(/\/$/, '') + path;
}
