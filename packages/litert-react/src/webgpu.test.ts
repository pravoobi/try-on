import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWebGPUAvailable } from './webgpu';

describe('isWebGPUAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when navigator.gpu exists', () => {
    vi.stubGlobal('navigator', { gpu: {} });
    expect(isWebGPUAvailable()).toBe(true);
  });

  it('returns false when navigator.gpu is absent', () => {
    vi.stubGlobal('navigator', {});
    expect(isWebGPUAvailable()).toBe(false);
  });
});
