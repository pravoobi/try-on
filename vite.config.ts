/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The LiteRT.js Wasm runtime is served from public/litert-wasm/, kept in sync
// from node_modules by tools/copy-litert-wasm.mjs (postinstall / predev).

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves this repo at /try-on/, not the domain root; keep the
  // dev server at / so local URLs/paths (e.g. fetch('/models/...')) don't change.
  // `command` is NOT 'build' during `vite preview` (it's 'serve' there too) —
  // `mode` is the correct signal: 'production' for both `vite build` and
  // `vite preview`, 'development' for `vite`/`vite dev`.
  base: mode === 'production' ? '/try-on/' : '/',
  plugins: [react()],
  server: {
    // Fixed, not just "preferred": Cache Storage (where the advanced-mode
    // depth model is cached, see docs/plan-3d-garment-assets.md §5.0) and
    // localStorage/IndexedDB are all scoped per-origin, and origin
    // includes the port. If a stale dev-server process is left running on
    // 5173, Vite's default behavior is to silently bind the next free port
    // instead — a different origin, so every "cached" download looks
    // fresh again. Fail loudly instead: closing the other process is a
    // five-second fix, silently losing the cache every session isn't.
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
  },
}));
