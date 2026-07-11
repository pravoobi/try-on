import { useEffect, useState } from 'react';
import catalogData from '../garments/catalog.json';
import { validateCatalog, type Garment } from '../garments/schema';

export type CatalogStatus = 'loading' | 'ready' | 'error';

export interface UseGarmentCatalog {
  garments: Garment[];
  status: CatalogStatus;
  error: string | null;
}

/**
 * catalog.json lives under src/garments/ (source data, not a static asset —
 * unlike the garment PNGs, which are fetched from public/garments/ by URL),
 * so it's bundled via a JSON import rather than fetch().
 */
export function useGarmentCatalog(): UseGarmentCatalog {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [status, setStatus] = useState<CatalogStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setGarments(validateCatalog(catalogData));
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { garments, status, error };
}
