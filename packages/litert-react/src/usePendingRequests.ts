import { useCallback, useRef } from 'react';

interface Pending<TResult> {
  resolve: (value: TResult) => void;
  reject: (err: Error) => void;
}

export interface UsePendingRequests<TResult> {
  /** Registers a new pending request under a fresh sequence number, returning it alongside the promise that `resolve`/`reject` will settle. Send `seq` to your worker so the response can be matched back to this promise. */
  create: () => { seq: number; promise: Promise<TResult> };
  /** Settles the pending request for `seq` (a no-op if already resolved/rejected or unknown — e.g. a stale response after teardown). */
  resolve: (seq: number, value: TResult) => void;
  reject: (seq: number, err: Error) => void;
  /** Rejects every still-pending request — call this on worker teardown/crash so in-flight callers don't hang forever. */
  rejectAll: (err: Error) => void;
}

/**
 * The seq-keyed pending-promise map every request/response Worker protocol
 * needs: `create()` when you send a request, `resolve`/`reject` when the
 * matching response arrives (by `seq`), `rejectAll` on teardown.
 */
export function usePendingRequests<TResult>(): UsePendingRequests<TResult> {
  const pendingRef = useRef(new Map<number, Pending<TResult>>());
  const seqRef = useRef(0);

  const create = useCallback((): { seq: number; promise: Promise<TResult> } => {
    const seq = ++seqRef.current;
    const promise = new Promise<TResult>((resolve, reject) => {
      pendingRef.current.set(seq, { resolve, reject });
    });
    return { seq, promise };
  }, []);

  const resolveFn = useCallback((seq: number, value: TResult) => {
    const p = pendingRef.current.get(seq);
    pendingRef.current.delete(seq);
    p?.resolve(value);
  }, []);

  const rejectFn = useCallback((seq: number, err: Error) => {
    const p = pendingRef.current.get(seq);
    pendingRef.current.delete(seq);
    p?.reject(err);
  }, []);

  const rejectAll = useCallback((err: Error) => {
    for (const p of pendingRef.current.values()) p.reject(err);
    pendingRef.current.clear();
  }, []);

  return { create, resolve: resolveFn, reject: rejectFn, rejectAll };
}
