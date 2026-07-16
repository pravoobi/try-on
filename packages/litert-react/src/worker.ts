/**
 * Worker-side LiteRT.js runtime bootstrapping — import this from your own
 * inference Worker's entry file, NOT the main thread (it patches
 * `self.importScripts`, which only exists in a worker context, and pulls in
 * `@litertjs/core` which main-thread bundles don't need). See the README for
 * why each of these is necessary; in short, LiteRT.js 2.5.x assumes a classic
 * (non-module) worker's synchronous `importScripts`, which Vite/most bundlers
 * only support for module workers — none of this is LiteRT.js being
 * unusual, it's the standard shim every LiteRT.js-in-a-module-worker setup
 * needs.
 */
import { isWebGPUSupported, loadLiteRt, supportsFeature } from '@litertjs/core';

export type Accelerator = 'webgpu' | 'wasm';

/**
 * Shadows `importScripts` with a same-semantics shim: synchronous fetch +
 * eval in global scope. LiteRT.js loads its Wasm JS glue via
 * `importScripts()` whenever the function exists — but a *module* worker
 * (the only kind Vite dev supports) has no such function; even where one
 * exists (classic workers), some bundlers' dev servers don't serve a URL
 * `importScripts` can synchronously XHR. This shim makes the glue's
 * top-level `var ModuleFactory` land on `self`, exactly as LiteRT expects,
 * regardless of worker type.
 */
export function installLiteRTWasmShim(): void {
  (self as unknown as { importScripts?: (...urls: string[]) => void }).importScripts = (
    ...urls: string[]
  ) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send();
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`installLiteRTWasmShim: ${xhr.status} for ${url}`);
      }
      // eslint-disable-next-line no-eval
      (0, eval)(xhr.responseText);
    }
  };
}

export interface LoadLiteRTRuntimeOptions {
  /** Resolves a filename (e.g. the .wasm binary) relative to your own Wasm asset directory. Defaults to `wasmPath + file`. */
  locateFile?: (file: string) => string;
}

export interface LiteRTRuntimeInfo {
  /** Whether the JSPI (JavaScript Promise Integration) Wasm feature is available — GPU→CPU tensor readback in the Wasm glue is Asyncify-based, and only the JSPI build ships the Asyncify runtime, so WebGPU inference requires it (Chrome 137+ at time of writing). Feed this into resolveAccelerator. */
  jspi: boolean;
}

/**
 * Installs the wasm shim, points LiteRT's Emscripten `Module.locateFile` at
 * your Wasm asset directory (since the eval'd glue script has no script URL
 * of its own, Emscripten would otherwise resolve the `.wasm` relative to
 * this worker's own URL), detects JSPI support, and loads the LiteRT
 * runtime. Call this once, before creating any model.
 */
export async function loadLiteRTRuntime(
  wasmPath: string,
  opts: LoadLiteRTRuntimeOptions = {},
): Promise<LiteRTRuntimeInfo> {
  installLiteRTWasmShim();
  (self as unknown as { Module?: { locateFile(file: string): string } }).Module = {
    locateFile: opts.locateFile ?? ((file) => wasmPath + file),
  };
  const jspi = await supportsFeature('jspi');
  await loadLiteRt(wasmPath, { jspi });
  return { jspi };
}

/**
 * Decides webgpu vs. wasm given the caller's preference and the runtime
 * capabilities `loadLiteRTRuntime` reported — WebGPU only if requested,
 * JSPI is available, and the browser actually supports WebGPU.
 */
export function resolveAccelerator(preferred: Accelerator, runtime: LiteRTRuntimeInfo): Accelerator {
  return preferred === 'webgpu' && runtime.jspi && isWebGPUSupported() ? 'webgpu' : 'wasm';
}
