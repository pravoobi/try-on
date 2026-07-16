# litert-react

React hooks for [LiteRT.js](https://ai.google.dev/edge/litert/web) and, more
generally, any Worker-based ML inference: model loading with progress, a
typed Web Worker request/response protocol, WebGPU detection with CPU
fallback, and a self-pacing frame-throttled loop for live video inference.

LiteRT.js has essentially no React ecosystem yet — this is the integration
layer extracted from
[pravoobi/try-on](https://github.com/pravoobi/try-on)'s real-time,
on-device virtual try-on app (segmentation + pose estimation running live on
webcam video, in a Worker, on WebGPU with automatic CPU fallback).

## Install

```bash
npm install litert-react
# only if you use the worker-side helpers (see below):
npm install @litertjs/core
```

## What's in here

**Main thread** (`litert-react`):

- **`useWorkerLifecycle(active, createWorker, onCreate)`** — creates a
  Worker exactly when `active` becomes true, terminates it exactly when it
  becomes false (or on unmount). `onCreate(worker)` fires synchronously
  inside the same effect that creates the worker, so you can attach
  `onmessage`/`onerror` and send your init message before any response
  could possibly arrive. Returns a ref to the current worker for later
  `.postMessage()` calls from callbacks.
- **`usePendingRequests<TResult>()`** — the sequence-numbered pending-promise
  map every request/response Worker protocol needs: `create()` when you
  send a request, `resolve(seq, value)` / `reject(seq, err)` when the
  matching response arrives, `rejectAll(err)` on teardown so in-flight
  callers don't hang forever.
- **`useAggregateProgress()`** — combines progress across multiple
  concurrently-downloading model files (weights, config, tokenizer, ...)
  into one `[0,1]` fraction for a single progress bar.
- **`useThrottledLoop(tick, targetFps, active)`** — calls `tick` roughly
  `targetFps` times/sec, never overlapping; a slow tick delays the next one
  rather than queuing (no pile-up under load). Returns a smoothed `fps`
  reading. Built for "capture a video frame → run inference → publish the
  result", but `tick` can be anything.
- **`isWebGPUAvailable()`** — `'gpu' in navigator`, as a one-liner.

**Worker side** (`litert-react/worker`, needs `@litertjs/core`):

- **`installLiteRTWasmShim()`** — LiteRT.js 2.5.x loads its Wasm glue via
  `importScripts()`, which doesn't exist in a module worker (the only kind
  Vite dev supports). This shadows it with a same-semantics synchronous
  fetch + eval shim.
- **`loadLiteRTRuntime(wasmPath, opts?)`** — installs the shim, points
  Emscripten's `Module.locateFile` at your Wasm asset directory, detects
  JSPI support, and loads the runtime. Returns `{ jspi }`.
- **`resolveAccelerator(preferred, runtime)`** — `'webgpu'` only if
  requested, JSPI is available (GPU→CPU tensor readback needs the
  Asyncify-based JSPI build), and the browser actually supports WebGPU;
  `'wasm'` otherwise.

## Usage sketch

```ts
// main.ts — usePipeline-style hook
import { useWorkerLifecycle, usePendingRequests, useAggregateProgress } from 'litert-react';

function useMyModel(active: boolean) {
  const pending = usePendingRequests<MyResult>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const workerRef = useWorkerLifecycle(
    active,
    () => new Worker(new URL('./my.worker.ts', import.meta.url), { type: 'module' }),
    (worker) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') setStatus('ready');
        else if (e.data.type === 'result') pending.resolve(e.data.seq, e.data.value);
      };
      worker.postMessage({ type: 'init' });
    },
  );

  const run = useCallback((input: ImageBitmap) => {
    const { seq, promise } = pending.create();
    workerRef.current?.postMessage({ type: 'run', seq, input }, [input]);
    return promise;
  }, [pending, workerRef]);

  return { status, run };
}
```

```ts
// my.worker.ts
import { loadLiteRTRuntime, resolveAccelerator } from 'litert-react/worker';

const runtime = await loadLiteRTRuntime('/litert-wasm/');
const backend = resolveAccelerator('webgpu', runtime);
// ... load your model on `backend`, respond to postMessage as usual.
```

## License

MIT
