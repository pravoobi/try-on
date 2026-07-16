import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePendingRequests } from './usePendingRequests';

describe('usePendingRequests', () => {
  it('resolves a pending request by its seq', async () => {
    const { result } = renderHook(() => usePendingRequests<string>());
    let seq = -1;
    let promise!: Promise<string>;
    act(() => {
      const created = result.current.create();
      seq = created.seq;
      promise = created.promise;
    });
    act(() => {
      result.current.resolve(seq, 'hello');
    });
    await expect(promise).resolves.toBe('hello');
  });

  it('rejects a pending request by its seq', async () => {
    const { result } = renderHook(() => usePendingRequests<string>());
    let seq = -1;
    let promise!: Promise<string>;
    act(() => {
      const created = result.current.create();
      seq = created.seq;
      promise = created.promise;
    });
    act(() => {
      result.current.reject(seq, new Error('boom'));
    });
    await expect(promise).rejects.toThrow('boom');
  });

  it('issues distinct, increasing seq numbers for each request', () => {
    const { result } = renderHook(() => usePendingRequests<string>());
    let seq1 = -1;
    let seq2 = -1;
    act(() => {
      seq1 = result.current.create().seq;
      seq2 = result.current.create().seq;
    });
    expect(seq2).toBeGreaterThan(seq1);
  });

  it('resolving an unknown/already-settled seq is a no-op, not a throw', () => {
    const { result } = renderHook(() => usePendingRequests<string>());
    expect(() => {
      act(() => {
        result.current.resolve(999, 'nobody is waiting');
      });
    }).not.toThrow();
  });

  it('rejectAll settles every still-pending request and clears them', async () => {
    const { result } = renderHook(() => usePendingRequests<string>());
    let p1!: Promise<string>;
    let p2!: Promise<string>;
    act(() => {
      p1 = result.current.create().promise;
      p2 = result.current.create().promise;
    });
    act(() => {
      result.current.rejectAll(new Error('torn down'));
    });
    await expect(p1).rejects.toThrow('torn down');
    await expect(p2).rejects.toThrow('torn down');
  });
});
