/**
 * Resolves a root-relative asset path (e.g. "/models/x.tflite") against
 * Vite's configured base path. Needed because GitHub Pages serves this repo
 * from /try-on/, not the domain root (see vite.config.ts) — a hardcoded
 * leading-slash path in a fetch() call or <img src> is NOT rewritten by
 * Vite's `base` option (that only applies to assets Vite itself processes),
 * so every runtime path built from config.ts/catalog.json must go through
 * this before use.
 */
export function assetUrl(path: string): string {
  return import.meta.env.BASE_URL.replace(/\/$/, '') + path;
}
