import { useEffect, useState } from 'react';
import { assetUrl } from '../assetUrl';
import { isTwoPieceLehenga, type Garment } from '../garments/schema';
import { USER_GARMENT_ID_PREFIX } from '../garments/userGarmentStore';

interface Props {
  garments: Garment[];
  /** Ids of every worn garment — up to two with the top+bottom outfit slots (see App.tsx selectGarment). */
  selectedIds: readonly string[];
  onSelect: (garment: Garment | null) => void;
  /** Only ever called for a garment whose id has the user-upload prefix — the delete button (below) only renders for those. Omit to hide deletion entirely (e.g. a read-only picker). */
  onDelete?: (id: string) => void;
}

const CONFIRM_TIMEOUT_MS = 3000;

/** Tap the badge once to arm it, tap again (within CONFIRM_TIMEOUT_MS) to
 * actually delete — a non-blocking substitute for window.confirm(), whose
 * synchronous native dialog would freeze the JS thread (and the live
 * inference loop) for as long as it's open, a bad trade sitting on top of
 * a live camera view. Arming auto-expires so a stale "armed" badge can't
 * be fired by an unrelated later tap. */
function DeleteBadge({ id, onDelete }: { id: string; onDelete: (id: string) => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      className={'garment-thumb-delete' + (armed ? ' armed' : '')}
      aria-label={armed ? `confirm remove ${id}` : `remove ${id}`}
      onClick={() => {
        if (armed) {
          onDelete(id);
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? '✓' : '✕'}
    </button>
  );
}

export function GarmentPicker({ garments, selectedIds, onSelect, onDelete }: Props) {
  return (
    <div className="garment-picker">
      <div className="garment-thumb-wrap">
        <button
          className={'garment-thumb' + (selectedIds.length === 0 ? ' selected' : '')}
          onClick={() => onSelect(null)}
        >
          <span className="garment-thumb-none">none</span>
        </button>
      </div>
      {garments.map((g) => (
        // A real sibling <button> for delete, not nested inside the
        // selection button — a <button> can't validly contain another
        // interactive control. The wrapper is what the CSS grid/flex
        // strip actually sizes; see .garment-thumb-wrap.
        <div key={g.id} className="garment-thumb-wrap">
          <button
            className={'garment-thumb' + (selectedIds.includes(g.id) ? ' selected' : '')}
            onClick={() => onSelect(g)}
            title={`${g.id} (${g.category}, ${g.meta.sleeves}, ${g.meta.length}-length)`}
          >
            <img src={assetUrl(isTwoPieceLehenga(g) ? g.choli.image : g.image)} alt={g.id} />
          </button>
          {onDelete && g.id.startsWith(USER_GARMENT_ID_PREFIX) && <DeleteBadge id={g.id} onDelete={onDelete} />}
        </div>
      ))}
    </div>
  );
}
