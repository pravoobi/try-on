import { useCallback, useRef, useState } from 'react';

export interface UseAggregateProgress {
  /** Combined progress in [0, 1] across every file reported so far, or null before the first report (or after `reset`). */
  progress: number | null;
  /** Reports a file's current loaded/total (e.g. from a model-download progress event) — safe to call repeatedly for the same `key` as it updates. */
  report: (key: string, loaded: number, total: number) => void;
  reset: () => void;
}

/**
 * Aggregates progress across multiple concurrently-downloading files (a
 * model is often more than one file — weights, config, tokenizer, ...) into
 * one combined fraction, for a single progress bar. Model-loading libraries
 * that report per-file progress events (transformers.js's `progress_callback`
 * being the common case) usually don't tell you up front how many files
 * there are or their total combined size — this sums whatever's been
 * reported so far, so the fraction is exact once every file has reported at
 * least once and only approximate before that.
 */
export function useAggregateProgress(): UseAggregateProgress {
  const [progress, setProgress] = useState<number | null>(null);
  const filesRef = useRef(new Map<string, { loaded: number; total: number }>());

  const report = useCallback((key: string, loaded: number, total: number) => {
    filesRef.current.set(key, { loaded, total });
    let l = 0;
    let t = 0;
    for (const f of filesRef.current.values()) {
      l += f.loaded;
      t += f.total;
    }
    setProgress(t > 0 ? l / t : 0);
  }, []);

  const reset = useCallback(() => {
    filesRef.current.clear();
    setProgress(null);
  }, []);

  return { progress, report, reset };
}
