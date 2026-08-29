import { useCallback, useRef, useState } from 'react';

/**
 * The in-memory "saved looks" tray behind the WebMCP `save_look` /
 * `compare_looks` tools (see webmcp-challenge-plan.md Day 3).
 *
 * A look is a frozen snapshot of one try-on: the composited canvas as a
 * downscaled PNG plus which garment ids were worn. Deliberately not
 * persisted — the styling loop is a single session, and a stale look whose
 * garment has since left the catalog would be a footgun.
 */
export interface SavedLook {
  id: string;
  label: string;
  /** Downscaled PNG data URL of the composited preview at save time. */
  thumbnail: string;
  /** Garment ids worn in this look (top and/or bottom slot). */
  garmentIds: string[];
  createdAt: number;
}

export interface UseLooks {
  looks: SavedLook[];
  /** Ids currently selected for side-by-side comparison (the modal shows at ≥2). */
  comparison: string[];
  saveLook: (input: { label?: string; thumbnail: string; garmentIds: string[] }) => SavedLook;
  removeLook: (id: string) => void;
  /** Replace the comparison selection outright (the `compare_looks` tool). */
  setComparison: (ids: string[]) => void;
  /** Add/remove one id from the comparison selection (a human ticking a look). */
  toggleComparison: (id: string) => void;
  clearComparison: () => void;
}

export function useLooks(): UseLooks {
  const [looks, setLooks] = useState<SavedLook[]>([]);
  const [comparison, setComparisonState] = useState<string[]>([]);
  const counterRef = useRef(0);

  const saveLook = useCallback<UseLooks['saveLook']>((input) => {
    counterRef.current += 1;
    const n = counterRef.current;
    const look: SavedLook = {
      id: `look-${n}`,
      label: input.label?.trim() || `Look ${n}`,
      thumbnail: input.thumbnail,
      garmentIds: input.garmentIds,
      createdAt: Date.now(),
    };
    setLooks((prev) => [...prev, look]);
    return look;
  }, []);

  const removeLook = useCallback((id: string) => {
    setLooks((prev) => prev.filter((l) => l.id !== id));
    setComparisonState((prev) => prev.filter((x) => x !== id));
  }, []);

  const setComparison = useCallback((ids: string[]) => setComparisonState(ids), []);

  const toggleComparison = useCallback((id: string) => {
    setComparisonState((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const clearComparison = useCallback(() => setComparisonState([]), []);

  return {
    looks,
    comparison,
    saveLook,
    removeLook,
    setComparison,
    toggleComparison,
    clearComparison,
  };
}
