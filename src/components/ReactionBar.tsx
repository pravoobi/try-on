import { useState } from 'react';
import { REACTION_KINDS, type Reaction, type ReactionKind } from '../hooks/useReaction';

interface Props {
  /** True while the agent is blocked waiting on a reaction. */
  pending: boolean;
  last: Reaction | null;
  onReact: (kind: ReactionKind, note?: string) => void;
}

const CHIP: Record<ReactionKind, { emoji: string; label: string }> = {
  love: { emoji: '❤️', label: 'Love it' },
  like: { emoji: '👍', label: 'Good' },
  try_another: { emoji: '🔁', label: 'Try another' },
  reject: { emoji: '✕', label: 'Not this' },
};

/**
 * The human's half of the styling loop (webmcp-challenge-plan.md Day 4): four
 * reaction chips + an optional one-line note. Tapping a chip resolves the
 * agent's `await_reaction` call with structured data instead of the agent
 * having to parse a sentence of chat.
 */
export function ReactionBar({ pending, last, onReact }: Props) {
  const [note, setNote] = useState('');

  const react = (kind: ReactionKind) => {
    onReact(kind, note || undefined);
    setNote('');
  };

  return (
    <div className={'reaction-bar' + (pending ? ' pending' : '')}>
      <div className="reaction-bar-row">
        <span className="hint">
          {pending ? '⏳ the stylist is waiting for your reaction' : 'your reaction:'}
        </span>
        {REACTION_KINDS.map((kind) => (
          <button
            key={kind}
            className={'reaction-chip reaction-chip-' + kind}
            onClick={() => react(kind)}
            title={CHIP[kind].label}
          >
            {CHIP[kind].emoji} {CHIP[kind].label}
          </button>
        ))}
      </div>
      <input
        className="reaction-note"
        type="text"
        value={note}
        placeholder="optional: tell the stylist what to change (e.g. “more colour”, “shorter”)"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && note.trim()) react('try_another');
        }}
      />
      {last && (
        <span className="hint reaction-last">
          last: {CHIP[last.kind].emoji} {CHIP[last.kind].label}
          {last.note ? ` — “${last.note}”` : ''}
        </span>
      )}
    </div>
  );
}
