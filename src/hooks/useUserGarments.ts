import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteUserGarment,
  loadUserGarments,
  saveUserGarment,
  type StoredUserGarment,
} from '../garments/userGarmentStore';
import type { Garment } from '../garments/schema';
import type { GarmentAnchors, SkirtAnchors } from '@practics/tryon-core';

export type UserGarmentsStatus = 'loading' | 'ready' | 'error';

export interface UseUserGarments {
  garments: Garment[];
  status: UserGarmentsStatus;
  error: string | null;
  /** Persists a new upload to IndexedDB, adds it to the in-memory list immediately (no reload needed), and returns it so the caller can e.g. auto-select it. */
  addGarment: (stored: StoredUserGarment) => Promise<Garment>;
  removeGarment: (id: string) => Promise<void>;
}

function storedToGarment(s: StoredUserGarment): Garment {
  if (s.category === 'pants') {
    return {
      id: s.id,
      category: 'pants',
      image: URL.createObjectURL(s.front.imageBlob),
      anchors: s.front.anchors as SkirtAnchors,
      meta: s.meta,
    };
  }
  return {
    id: s.id,
    category: s.category,
    image: URL.createObjectURL(s.front.imageBlob),
    anchors: s.front.anchors as GarmentAnchors,
    ...(s.back
      ? { back: { image: URL.createObjectURL(s.back.imageBlob), anchors: s.back.anchors as GarmentAnchors } }
      : {}),
    meta: s.meta,
  };
}

function revokeGarmentUrls(g: Garment): void {
  if (g.category === 'lehenga-choli') return; // uploads never produce these
  URL.revokeObjectURL(g.image);
  if (g.category !== 'pants' && g.back) URL.revokeObjectURL(g.back.image);
}

/**
 * User-uploaded garments (Phase A4, see docs/plan-3d-garment-assets.md
 * §5.2), persisted in IndexedDB (userGarmentStore.ts) and surfaced here as
 * ordinary SinglePieceGarment objects — image/back.image are `blob:` object
 * URLs, which flow through the exact same fetch()/<img src> code paths as
 * catalog garments (see assetUrl.ts) with no special-casing elsewhere.
 */
export function useUserGarments(): UseUserGarments {
  const [garments, setGarments] = useState<Garment[]>([]);
  const [status, setStatus] = useState<UserGarmentsStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const garmentsRef = useRef<Garment[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await loadUserGarments();
        if (cancelled) return;
        const loaded = stored.map(storedToGarment);
        garmentsRef.current = loaded;
        setGarments(loaded);
        setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      // Only revoke on genuine unmount (StrictMode double-invokes effects in
      // dev, but this cleanup racing the async load above is harmless here
      // since garmentsRef is only populated after the load resolves).
      for (const g of garmentsRef.current) revokeGarmentUrls(g);
    };
  }, []);

  const addGarment = useCallback(async (stored: StoredUserGarment): Promise<Garment> => {
    await saveUserGarment(stored);
    const garment = storedToGarment(stored);
    garmentsRef.current = [...garmentsRef.current, garment];
    setGarments(garmentsRef.current);
    return garment;
  }, []);

  const removeGarment = useCallback(async (id: string): Promise<void> => {
    await deleteUserGarment(id);
    const removed = garmentsRef.current.find((g) => g.id === id);
    if (removed) revokeGarmentUrls(removed);
    garmentsRef.current = garmentsRef.current.filter((g) => g.id !== id);
    setGarments(garmentsRef.current);
  }, []);

  return { garments, status, error, addGarment, removeGarment };
}
