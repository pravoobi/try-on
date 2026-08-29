import type { SavedLook } from '../hooks/useLooks';

interface Props {
  looks: SavedLook[];
  /** Ids selected for comparison — the side-by-side modal opens at ≥2. */
  comparison: string[];
  /** Resolve a garment id to a short display label. */
  garmentLabel: (id: string) => string;
  /** Whether "save current look" is possible right now (photo loaded + a garment on). */
  canSave: boolean;
  onSaveCurrent: () => void;
  onToggleComparison: (id: string) => void;
  onClearComparison: () => void;
  onRemove: (id: string) => void;
}

function garmentSummary(look: SavedLook, garmentLabel: (id: string) => string): string {
  if (look.garmentIds.length === 0) return '—';
  return look.garmentIds.map(garmentLabel).join(' + ');
}

/**
 * The saved-looks tray + comparison view behind the WebMCP `save_look` /
 * `compare_looks` tools (see hooks/useLooks.ts). Also usable by hand: the
 * "save current look" button and the per-card compare toggle let the human
 * drive the same loop the agent does.
 */
export function LooksPanel({
  looks,
  comparison,
  garmentLabel,
  canSave,
  onSaveCurrent,
  onToggleComparison,
  onClearComparison,
  onRemove,
}: Props) {
  const compared = comparison
    .map((id) => looks.find((l) => l.id === id))
    .filter((l): l is SavedLook => !!l);
  const showComparison = compared.length >= 2;

  return (
    <section className="looks-panel">
      <div className="looks-panel-header">
        <span className="hint">saved looks{looks.length > 0 ? ` (${looks.length})` : ''}:</span>
        <button onClick={onSaveCurrent} disabled={!canSave} title="Snapshot the current try-on">
          ＋ save current look
        </button>
      </div>

      {looks.length === 0 ? (
        <p className="hint">
          Apply a garment, then save the look. Save two or more and the stylist (or you) can
          compare them side by side.
        </p>
      ) : (
        <div className="looks-strip">
          {looks.map((look) => {
            const inComparison = comparison.includes(look.id);
            return (
              <div key={look.id} className={'look-card' + (inComparison ? ' comparing' : '')}>
                <img src={look.thumbnail} alt={look.label} />
                <div className="look-card-label">{look.label}</div>
                <div className="look-card-garments">{garmentSummary(look, garmentLabel)}</div>
                <div className="look-card-actions">
                  <button
                    className="look-card-compare"
                    aria-pressed={inComparison}
                    onClick={() => onToggleComparison(look.id)}
                    title="Add to the side-by-side comparison"
                  >
                    {inComparison ? '✓ comparing' : 'compare'}
                  </button>
                  <button
                    className="look-card-remove"
                    aria-label={`remove ${look.label}`}
                    onClick={() => onRemove(look.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showComparison && (
        <div className="modal-overlay" onClick={onClearComparison}>
          <div
            className="modal-content looks-compare"
            role="dialog"
            aria-label="compare looks"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="looks-compare-header">
              <strong>Comparing {compared.length} looks</strong>
              <button aria-label="close comparison" onClick={onClearComparison}>
                ✕
              </button>
            </div>
            <div className="looks-compare-row">
              {compared.map((look) => (
                <figure key={look.id} className="looks-compare-item">
                  <img src={look.thumbnail} alt={look.label} />
                  <figcaption>
                    <span className="looks-compare-item-label">{look.label}</span>
                    <span className="hint">{garmentSummary(look, garmentLabel)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className="hint">Which one works? Tell the stylist "I like {compared[0]?.label}" or "try another".</p>
          </div>
        </div>
      )}
    </section>
  );
}
