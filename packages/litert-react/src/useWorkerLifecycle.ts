import { useEffect, useRef } from 'react';

/**
 * Creates a Worker exactly when `active` becomes true, terminates it exactly
 * when `active` becomes false (or on unmount), and hands you the worker
 * synchronously (via `onCreate`, called inside the same effect that creates
 * it) so you can attach `onmessage`/`onerror` and send your init message
 * before any message could possibly arrive — no separate effect, no
 * render-cycle race.
 *
 * Returns a ref (not state): callers typically need to `.postMessage()` on
 * the current worker later, from an event handler or callback, not react to
 * its identity changing during render.
 */
export function useWorkerLifecycle(
  active: boolean,
  createWorker: () => Worker,
  onCreate: (worker: Worker) => void,
): React.RefObject<Worker | null> {
  const workerRef = useRef<Worker | null>(null);
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;

  useEffect(() => {
    if (!active) {
      workerRef.current = null;
      return;
    }
    const worker = createWorker();
    workerRef.current = worker;
    onCreateRef.current(worker);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return workerRef;
}
