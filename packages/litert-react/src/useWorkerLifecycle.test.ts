import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkerLifecycle } from './useWorkerLifecycle';

/** A minimal stand-in for a real Worker — useWorkerLifecycle only ever calls .terminate() on it and hands the rest to the caller, so nothing more is needed to test it. */
function makeFakeWorker() {
  return { terminate: vi.fn(), postMessage: vi.fn() } as unknown as Worker;
}

describe('useWorkerLifecycle', () => {
  it('creates a worker and calls onCreate synchronously within the same effect when active', () => {
    const worker = makeFakeWorker();
    const createWorker = vi.fn(() => worker);
    const onCreate = vi.fn();
    const { result } = renderHook(() => useWorkerLifecycle(true, createWorker, onCreate));

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(worker);
    expect(result.current.current).toBe(worker);
  });

  it('does not create a worker while inactive', () => {
    const createWorker = vi.fn(() => makeFakeWorker());
    const onCreate = vi.fn();
    const { result } = renderHook(() => useWorkerLifecycle(false, createWorker, onCreate));

    expect(createWorker).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(result.current.current).toBeNull();
  });

  it('terminates the worker and clears the ref when active flips to false', () => {
    const worker = makeFakeWorker();
    const { result, rerender } = renderHook(({ active }) => useWorkerLifecycle(active, () => worker, () => {}), {
      initialProps: { active: true },
    });
    expect(result.current.current).toBe(worker);

    rerender({ active: false });

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(result.current.current).toBeNull();
  });

  it('terminates the worker on unmount', () => {
    const worker = makeFakeWorker();
    const { unmount } = renderHook(() => useWorkerLifecycle(true, () => worker, () => {}));
    unmount();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh worker after a flip back to active following deactivation', () => {
    const workerA = makeFakeWorker();
    const workerB = makeFakeWorker();
    let call = 0;
    const createWorker = vi.fn(() => (++call === 1 ? workerA : workerB));
    const { result, rerender } = renderHook(({ active }) => useWorkerLifecycle(active, createWorker, () => {}), {
      initialProps: { active: true },
    });
    expect(result.current.current).toBe(workerA);

    rerender({ active: false });
    expect(workerA.terminate).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    expect(result.current.current).toBe(workerB);
  });
});
