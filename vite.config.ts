/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    // LiteRT.js loads its Wasm runtime from a served directory (see loadLiteRt in
    // inference.worker.ts); copy it out of node_modules at dev/build time.
    viteStaticCopy({
      targets: [{ src: 'node_modules/@litertjs/core/wasm/*', dest: 'litert-wasm' }],
    }),
  ],
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
  },
});
