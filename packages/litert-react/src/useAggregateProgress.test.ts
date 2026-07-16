import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAggregateProgress } from './useAggregateProgress';

describe('useAggregateProgress', () => {
  it('starts at null before anything is reported', () => {
    const { result } = renderHook(() => useAggregateProgress());
    expect(result.current.progress).toBeNull();
  });

  it('reports a single file\'s fraction directly', () => {
    const { result } = renderHook(() => useAggregateProgress());
    act(() => result.current.report('model.bin', 50, 100));
    expect(result.current.progress).toBeCloseTo(0.5);
  });

  it('sums loaded/total across multiple concurrently-reporting files', () => {
    const { result } = renderHook(() => useAggregateProgress());
    act(() => {
      result.current.report('a.bin', 30, 100);
      result.current.report('b.bin', 10, 50);
    });
    // (30+10) / (100+50) = 40/150
    expect(result.current.progress).toBeCloseTo(40 / 150);
  });

  it('updates in place for a repeated key rather than double-counting it', () => {
    const { result } = renderHook(() => useAggregateProgress());
    act(() => {
      result.current.report('a.bin', 10, 100);
      result.current.report('a.bin', 60, 100);
    });
    expect(result.current.progress).toBeCloseTo(0.6);
  });

  it('reset clears back to null', () => {
    const { result } = renderHook(() => useAggregateProgress());
    act(() => result.current.report('a.bin', 10, 100));
    act(() => result.current.reset());
    expect(result.current.progress).toBeNull();
  });
});
