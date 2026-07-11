import { assetUrl } from '../assetUrl';
import type { Garment } from '../garments/schema';

interface Props {
  garments: Garment[];
  selectedId: string | null;
  onSelect: (garment: Garment | null) => void;
}

export function GarmentPicker({ garments, selectedId, onSelect }: Props) {
  return (
    <div className="garment-picker">
      <button
        className={'garment-thumb' + (selectedId === null ? ' selected' : '')}
        onClick={() => onSelect(null)}
      >
        <span className="garment-thumb-none">none</span>
      </button>
      {garments.map((g) => (
        <button
          key={g.id}
          className={'garment-thumb' + (g.id === selectedId ? ' selected' : '')}
          onClick={() => onSelect(g)}
          title={`${g.id} (${g.category}, ${g.meta.sleeves}, ${g.meta.length}-length)`}
        >
          <img src={assetUrl(g.category === 'lehenga-choli' ? g.choli.image : g.image)} alt={g.id} />
        </button>
      ))}
    </div>
  );
}
