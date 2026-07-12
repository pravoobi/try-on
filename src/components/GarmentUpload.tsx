import { useEffect, useState } from 'react';
import { AnchorEditor } from './AnchorEditor';
import { useMatting } from '../hooks/useMatting';
import type { StoredUserGarment } from '../garments/userGarmentStore';
import {
  GARMENT_CATEGORIES,
  HEM_LENGTHS,
  SLEEVE_LENGTHS,
  type GarmentCategory,
  type SleeveLength,
} from '../garments/schema';
import { cropToAlphaBBox, suggestAnchors } from '../pipeline/autoAnchor';
import type { GarmentAnchors, HemLength } from '../pipeline/types';

interface Draft {
  image: ImageBitmap;
  anchors: GarmentAnchors;
}

type UploadStep =
  | { kind: 'closed' }
  | { kind: 'front-select' }
  | { kind: 'front-processing'; note: string }
  | { kind: 'front-edit'; front: Draft }
  | { kind: 'back-select'; front: Draft }
  | { kind: 'back-processing'; front: Draft; note: string }
  | { kind: 'back-edit'; front: Draft; back: Draft }
  | { kind: 'saving'; front: Draft; back?: Draft };

const UPLOAD_CATEGORIES = GARMENT_CATEGORIES.filter(
  (c): c is Exclude<GarmentCategory, 'lehenga-choli'> => c !== 'lehenga-choli',
);

type UploadCategory = Exclude<GarmentCategory, 'lehenga-choli'>;

/** Typical hem length per category — applied when the user changes the
 * category select, since length (not category) is what actually drives how
 * far the garment hangs on the body when rendered (see
 * pipeline/anchorMapping.ts computeHem). Still editable afterward. */
const CATEGORY_DEFAULT_LENGTH: Record<UploadCategory, HemLength> = {
  top: 'hip',
  kurti: 'knee',
  dress: 'knee',
  saree: 'ankle',
};

/**
 * Suggests category + hem length from the cropped garment silhouette's
 * proportions: a top is roughly as tall as it is wide, a knee-length dress
 * is noticeably taller, a full-length gown taller still. A starting point
 * only — the selects stay editable, and getting `length` right matters
 * more than `category` (length is what makes it render as a dress rather
 * than stopping at the hips).
 */
function suggestMeta(w: number, h: number): { category: UploadCategory; length: HemLength } {
  const ratio = h / Math.max(1, w);
  if (ratio >= 1.9) return { category: 'dress', length: 'ankle' };
  if (ratio >= 1.3) return { category: 'dress', length: 'knee' };
  return { category: 'top', length: 'hip' };
}

function fallbackAnchors(w: number, h: number): GarmentAnchors {
  return {
    shoulderL: [w * 0.2, h * 0.05],
    shoulderR: [w * 0.8, h * 0.05],
    waistL: [w * 0.25, h * 0.55],
    waistR: [w * 0.75, h * 0.55],
    hemL: [w * 0.15, h * 0.95],
    hemR: [w * 0.85, h * 0.95],
  };
}

interface Props {
  onGarmentAdded: (garment: StoredUserGarment) => Promise<unknown>;
}

/**
 * User garment upload flow (Phase A4, see docs/plan-3d-garment-assets.md
 * §5.2): photo → in-browser background removal → auto-crop → auto-suggest
 * anchors → drag-adjust → optional back photo (same flow) → save. All
 * client-side; the matting model downloads lazily on first use of this
 * panel, independent of (and lazier than) the depth model.
 */
export function GarmentUpload({ onGarmentAdded }: Props) {
  const matting = useMatting();
  const [step, setStep] = useState<UploadStep>({ kind: 'closed' });
  const [category, setCategory] = useState<Exclude<GarmentCategory, 'lehenga-choli'>>('top');
  const [sleeves, setSleeves] = useState<SleeveLength>('half');
  const [length, setLength] = useState<HemLength>('hip');
  const [error, setError] = useState<string | null>(null);

  // Close the panel if advanced mode itself gets turned off elsewhere —
  // this whole feature depends on the same opt-in ML infrastructure.
  useEffect(() => {
    return () => {
      matting.setEnabled(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = () => {
    matting.setEnabled(true);
    setError(null);
    setStep({ kind: 'front-select' });
  };

  const close = () => {
    matting.setEnabled(false);
    setError(null);
    setStep({ kind: 'closed' });
  };

  const processPhoto = async (file: File): Promise<Draft | null> => {
    const raw = await createImageBitmap(file);
    const matted = await matting.removeBackground(raw); // transfers `raw`
    const cropped = await cropToAlphaBBox(matted);
    matted.close();
    if (!cropped) {
      setError("couldn't detect a garment in that photo — try one with a plain background");
      return null;
    }
    const anchors =
      suggestAnchors(cropped.alphaData, cropped.width, cropped.height) ??
      fallbackAnchors(cropped.width, cropped.height);
    return { image: cropped.bitmap, anchors };
  };

  const onFrontFile = async (file: File) => {
    setError(null);
    setStep({ kind: 'front-processing', note: 'removing background…' });
    try {
      const front = await processPhoto(file);
      if (!front) {
        setStep({ kind: 'front-select' });
        return;
      }
      const suggested = suggestMeta(front.image.width, front.image.height);
      setCategory(suggested.category);
      setLength(suggested.length);
      setStep({ kind: 'front-edit', front });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'front-select' });
    }
  };

  const onBackFile = async (front: Draft, file: File) => {
    setError(null);
    setStep({ kind: 'back-processing', front, note: 'removing background…' });
    try {
      const back = await processPhoto(file);
      if (!back) {
        setStep({ kind: 'back-select', front });
        return;
      }
      setStep({ kind: 'back-edit', front, back });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'back-select', front });
    }
  };

  const save = async (front: Draft, back: Draft | undefined) => {
    setStep({ kind: 'saving', front, back });
    try {
      const [frontBlob, backBlob] = await Promise.all([
        bitmapToBlob(front.image),
        back ? bitmapToBlob(back.image) : Promise.resolve(null),
      ]);
      const stored: StoredUserGarment = {
        id: `user-${crypto.randomUUID()}`,
        category,
        front: { imageBlob: frontBlob, anchors: front.anchors },
        ...(backBlob ? { back: { imageBlob: backBlob, anchors: back!.anchors } } : {}),
        meta: { sleeves, length },
        createdAt: Date.now(),
      };
      await onGarmentAdded(stored);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'front-edit', front });
    }
  };

  if (step.kind === 'closed') {
    return (
      <div className="controls">
        <button onClick={open}>upload your own garment</button>
      </div>
    );
  }

  return (
    <div className="garment-upload">
      <div className="controls">
        <span className="hint">upload your own garment</span>
        <button onClick={close}>cancel</button>
      </div>

      {matting.status === 'downloading' && (
        <p className="hint">
          downloading background-removal model…{' '}
          {matting.progress !== null ? `${Math.round(matting.progress * 100)}%` : ''}
        </p>
      )}
      {matting.status === 'error' && <p className="error">matting failed: {matting.error}</p>}
      {error && <p className="error">{error}</p>}

      {step.kind === 'front-select' && (
        <>
          <p className="hint">
            front photo — flat-lay, on a hanger, or worn by someone (the person is removed
            automatically, keeping just the top/dress).
          </p>
          <label>
            <input
              type="file"
              accept="image/*"
              disabled={matting.status !== 'ready'}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void onFrontFile(file);
              }}
            />
          </label>
        </>
      )}

      {(step.kind === 'front-processing' || step.kind === 'back-processing') && (
        <p className="hint">{step.note}</p>
      )}

      {step.kind === 'front-edit' && (
        <>
          <p className="hint">
            drag the yellow markers to fine-tune the anchors, then set the details below —
            "length" is what decides how far it hangs on the body (hip ≈ top, knee/ankle ≈ dress).
          </p>
          <AnchorEditor
            image={step.front.image}
            anchors={step.front.anchors}
            onChange={(anchors) => setStep({ kind: 'front-edit', front: { ...step.front, anchors } })}
          />
          <div className="controls">
            <label>
              category{' '}
              <select
                value={category}
                onChange={(e) => {
                  const next = e.target.value as UploadCategory;
                  setCategory(next);
                  setLength(CATEGORY_DEFAULT_LENGTH[next]);
                }}
              >
                {UPLOAD_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              sleeves{' '}
              <select value={sleeves} onChange={(e) => setSleeves(e.target.value as SleeveLength)}>
                {SLEEVE_LENGTHS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              length{' '}
              <select value={length} onChange={(e) => setLength(e.target.value as HemLength)}>
                {HEM_LENGTHS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="controls">
            <button onClick={() => setStep({ kind: 'back-select', front: step.front })}>
              continue
            </button>
          </div>
        </>
      )}

      {step.kind === 'back-select' && (
        <>
          <p className="hint">add a photo of the back? optional — skip if you only have the front.</p>
          <div className="controls">
            <label>
              back photo{' '}
              <input
                type="file"
                accept="image/*"
                disabled={matting.status !== 'ready'}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void onBackFile(step.front, file);
                }}
              />
            </label>
            <button onClick={() => void save(step.front, undefined)}>skip &amp; save</button>
          </div>
        </>
      )}

      {step.kind === 'back-edit' && (
        <>
          <p className="hint">drag the yellow markers to fine-tune the back anchors.</p>
          <AnchorEditor
            image={step.back.image}
            anchors={step.back.anchors}
            onChange={(anchors) =>
              setStep({ kind: 'back-edit', front: step.front, back: { ...step.back, anchors } })
            }
          />
          <div className="controls">
            <button onClick={() => void save(step.front, step.back)}>save</button>
          </div>
        </>
      )}

      {step.kind === 'saving' && <p className="hint">saving…</p>}
    </div>
  );
}

async function bitmapToBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('bitmapToBlob: no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
