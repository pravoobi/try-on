/** True if this browser exposes `navigator.gpu` at all. This is a coarse, synchronous, main-thread-only signal — it doesn't guarantee an adapter is actually available (that requires an async `navigator.gpu.requestAdapter()` call), just that it's worth trying WebGPU rather than requesting a wasm/CPU worker outright. */
export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
