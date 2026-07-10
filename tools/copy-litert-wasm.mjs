/**
 * Copies the LiteRT.js Wasm runtime out of node_modules into public/litert-wasm/
 * (gitignored) so loadLiteRt() can fetch it. Runs on postinstall and before
 * dev/build. (vite-plugin-static-copy's dev middleware doesn't serve the files
 * under Vite 8, so we serve them from public/ instead.)
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', '@litertjs', 'core', 'wasm');
const dest = path.join(root, 'public', 'litert-wasm');

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log('copied LiteRT wasm runtime -> public/litert-wasm/');
