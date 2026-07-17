import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { computeHarmonizeGains, type SceneColorStats } from './harmonize';

const CONFIG = DEFAULT_CONFIG.harmonize;

/** Stats for a neutral gray scene at a given luma. */
function grayScene(lum: number): SceneColorStats {
  return { personMean: [lum, lum, lum], personLum: lum };
}

describe('computeHarmonizeGains', () => {
  it('is identity when garment and scene already match (neutral scene, equal luma)', () => {
    const gains = computeHarmonizeGains(grayScene(128), 128, CONFIG);
    for (const g of gains) expect(g).toBeCloseTo(1, 6);
  });

  it('darkens a bright garment toward a dark scene, by strength not fully', () => {
    const gains = computeHarmonizeGains(grayScene(80), 160, CONFIG);
    // raw exposure 0.5 → blended: 1 + (0.5-1)*strength, floored at minExposure
    const expected = Math.max(CONFIG.minExposure, 1 + (0.5 - 1) * CONFIG.exposureStrength);
    for (const g of gains) expect(g).toBeCloseTo(expected, 6);
  });

  it('clamps extreme exposure to the configured bounds', () => {
    const dark = computeHarmonizeGains(grayScene(10), 250, CONFIG);
    expect(dark[0]).toBeCloseTo(CONFIG.minExposure, 6);
    const bright = computeHarmonizeGains(grayScene(250), 10, CONFIG);
    expect(bright[0]).toBeCloseTo(CONFIG.maxExposure, 6);
  });

  it('tilts channels toward a warm scene, red up and blue down, within cast clamps', () => {
    // Warm-lit person region: red above luma, blue below.
    const stats: SceneColorStats = { personMean: [150, 128, 100], personLum: 128.85 };
    const gains = computeHarmonizeGains(stats, 128.85, CONFIG); // equal luma → pure cast
    expect(gains[0]).toBeGreaterThan(1);
    expect(gains[2]).toBeLessThan(1);
    expect(gains[0]).toBeLessThanOrEqual(CONFIG.maxCast);
    expect(gains[2]).toBeGreaterThanOrEqual(CONFIG.minCast);
  });

  it('exposureStrength override 0 disables exposure but keeps the cast', () => {
    const stats: SceneColorStats = { personMean: [150, 128, 100], personLum: 128.85 };
    const gains = computeHarmonizeGains(stats, 40, CONFIG, 0); // huge luma mismatch, ignored
    const pureCast = computeHarmonizeGains(stats, 128.85, CONFIG);
    for (let c = 0; c < 3; c++) expect(gains[c]).toBeCloseTo(pureCast[c], 6);
  });
});
