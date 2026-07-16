import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThrottledLoop } from './useThrottledLoop';

describe('useThrottledLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls tick repeatedly while active', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useThrottledLoop(tick, 10, true));

    // First tick fires synchronously (via the initial effect's void loop()).
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100); // ~1 more tick at 10fps (100ms/tick)
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not call tick while inactive', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useThrottledLoop(tick, 10, false));
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).not.toHaveBeenCalled();
  });

  it('stops calling tick after deactivation', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ active }) => useThrottledLoop(tick, 10, active), {
      initialProps: { active: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    const callsWhileActive = tick.mock.calls.length;
    expect(callsWhileActive).toBeGreaterThan(0);

    rerender({ active: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(tick.mock.calls.length).toBe(callsWhileActive);
  });

  it('resets fps to 0 immediately on deactivation', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ active }) => useThrottledLoop(tick, 30, active), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    expect(result.current.fps).toBe(0);
  });

  it('a tick that rejects does not stop the loop', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('inference failed'));
    renderHook(() => useThrottledLoop(tick, 10, true));
    await vi.advanceTimersByTimeAsync(0);
    const first = tick.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(tick.mock.calls.length).toBeGreaterThan(first);
  });

  it('reports a nonzero fps once at least two ticks have elapsed', async () => {
    vi.useRealTimers(); // real timing needed for a genuine fps measurement
    const tick = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useThrottledLoop(tick, 30, true));
    await waitFor(() => expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(result.current.fps).toBeGreaterThan(0));
  });
});
