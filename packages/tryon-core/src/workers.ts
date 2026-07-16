/**
 * Ready-made Worker factories for this package's three workers — import
 * from '@practics/tryon-core/workers', not the main entry point, so a
 * consumer who only needs (say) the compositor doesn't pull `@litertjs/core`
 * or `@huggingface/transformers` into their main-thread bundle.
 *
 * Each factory does `new Worker(new URL('./workers/xxx.js', import.meta.url))`
 * *inside this package's own compiled module* — a relative path resolved
 * against this module's own real location (in node_modules or a linked
 * workspace), which is standard, bundler-agnostic ESM behavior (Vite,
 * webpack 5+, and plain browser ESM all resolve it the same way) — the
 * consuming app never needs to know these workers' file paths itself.
 */

export function createInferenceWorker(): Worker {
  return new Worker(new URL('./workers/inference.worker.js', import.meta.url), { type: 'module' });
}

export function createMattingWorker(): Worker {
  return new Worker(new URL('./workers/matting.worker.js', import.meta.url), { type: 'module' });
}

export function createDepthWorker(): Worker {
  return new Worker(new URL('./workers/depth.worker.js', import.meta.url), { type: 'module' });
}
