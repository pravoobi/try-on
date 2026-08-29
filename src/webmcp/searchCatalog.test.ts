import { describe, expect, it } from 'vitest';
import catalogData from '../garments/catalog.json';
import { validateCatalog } from '../garments/schema';
import { searchCatalog } from './searchCatalog';

const catalog = validateCatalog(catalogData);

describe('searchCatalog', () => {
  it('returns the whole catalog for an empty query', () => {
    expect(searchCatalog(catalog, {})).toHaveLength(catalog.length);
  });

  it('honours a price ceiling', () => {
    const hits = searchCatalog(catalog, { maxPrice: 8000 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.price !== null && h.price <= 8000)).toBe(true);
    // The lehengas (₹12.5k+) must be excluded.
    expect(hits.some((h) => h.category === 'lehenga-choli')).toBe(false);
  });

  it('filters by occasion tag', () => {
    const hits = searchCatalog(catalog, { occasion: 'sangeet' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.occasion.includes('sangeet'))).toBe(true);
  });

  it('combines occasion + budget the way the demo script does', () => {
    // "something for a Sangeet under ₹8k" → the magenta wrap dress, not a lehenga.
    const hits = searchCatalog(catalog, { occasion: 'sangeet', maxPrice: 8000 });
    expect(hits.map((h) => h.id)).toContain('dress-magenta-wrap-01');
    expect(hits.every((h) => (h.price ?? 0) <= 8000)).toBe(true);
  });

  it('ranks a free-text query by relevance', () => {
    const hits = searchCatalog(catalog, { query: 'red lehenga for a wedding' });
    expect(hits[0]?.id).toBe('lehenga-sangria');
  });

  it('drops garments a query does not touch at all', () => {
    const hits = searchCatalog(catalog, { query: 'lehenga' });
    expect(hits.every((h) => h.category === 'lehenga-choli')).toBe(true);
  });

  it('filters by category, accepting the "lehenga" alias', () => {
    const hits = searchCatalog(catalog, { category: 'lehenga' });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.category === 'lehenga-choli')).toBe(true);
  });

  it('returns nothing for an impossible combination', () => {
    expect(searchCatalog(catalog, { occasion: 'sangeet', maxPrice: 100 })).toEqual([]);
  });
});
