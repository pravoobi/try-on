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
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
  },
}));
