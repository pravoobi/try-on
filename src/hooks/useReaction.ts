import { useCallback, useRef, useState } from 'react';

/**
 * The structured human→agent reaction channel (webmcp-challenge-plan.md
 * Day 4). Instead of the agent guessing from free-text chat, the human taps
 * one of four reaction chips and the agent reads the verdict through the
 * `await_reaction` WebMCP tool.
 *
 * `awaitNext` is the agent side: it resolves with the next chip tap, or
 * immediately with a fresh unconsumed one, or `null` on timeout. `submit`
 * is the human side (the chips in ReactionBar).
 */
export type ReactionKind = 'love' | 'like' | 'try_another' | 'reject';

export const REACTION_KINDS: readonly ReactionKind[] = ['love', 'like', 'try_another', 'reject'];

export interface Reaction {
  kind: ReactionKind;
  note: string | null;
  at: number;
}

interface Waiter {
  resolve: (r: Reaction | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface UseReaction {
  last: Reaction | null;
  /** True while an agent is blocked in `awaitNext` — the UI nudges the human. */
  pending: boolean;
  /** Human taps a reaction chip. */
  submit: (kind: ReactionKind, note?: string) => void;
  /**
   * Agent side, chat channel: the user already said how they feel, so log it
   * to the app (updates `last`, resolves any waiter) and mark it consumed —
   * the caller already has it, so a follow-up `awaitNext` shouldn't re-serve it.
   */
  record: (kind: ReactionKind, note?: string) => void;
  /** Agent side, chip channel: the next reaction (or a fresh unconsumed one), `null` on timeout. */
  awaitNext: (timeoutMs: number) => Promise<Reaction | null>;
}

export function useReaction(): UseReaction {
  const [last, setLast] = useState<Reaction | null>(null);
  const [pending, setPending] = useState(false);
  const lastRef = useRef<Reaction | null>(null);
  /** `at` of the most recent reaction already handed to an agent. */
  const consumedAtRef = useRef(0);
  const waitersRef = useRef<Waiter[]>([]);

  const submit = useCallback((kind: ReactionKind, note?: string): Reaction => {
    const reaction: Reaction = { kind, note: note?.trim() || null, at: Date.now() };
    lastRef.current = reaction;
    setLast(reaction);

    const waiters = waitersRef.current;
    waitersRef.current = [];
    if (waiters.length > 0) {
      consumedAtRef.current = reaction.at;
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(reaction);
      }
      setPending(false);
    }
    return reaction;
  }, []);

  const record = useCallback(
    (kind: ReactionKind, note?: string) => {
      const reaction = submit(kind, note);
      consumedAtRef.current = reaction.at;
    },
    [submit],
  );

  const awaitNext = useCallback((timeoutMs: number) => {
    return new Promise<Reaction | null>((resolve) => {
      const fresh = lastRef.current;
      if (fresh && fresh.at > consumedAtRef.current) {
        consumedAtRef.current = fresh.at;
        resolve(fresh);
        return;
      }
      setPending(true);
      const timer = setTimeout(() => {
        waitersRef.current = waitersRef.current.filter((w) => w.timer !== timer);
        if (waitersRef.current.length === 0) setPending(false);
        resolve(null);
      }, timeoutMs);
      waitersRef.current.push({ resolve, timer });
    });
  }, []);

  return { last, pending, submit, record, awaitNext };
}
