/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The LiteRT.js Wasm runtime is served from public/litert-wasm/, kept in sync
// from node_modules by tools/copy-litert-wasm.mjs (postinstall / predev).

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
  },
});
