import { useEffect, useState } from 'react';
import { AnchorEditor, type AnchorMap } from './AnchorEditor';
import { TryOnPreview } from './TryOnPreview';
import { useMatting } from '../hooks/useMatting';
import { USER_GARMENT_ID_PREFIX, type StoredUserGarment } from '../garments/userGarmentStore';
import {
  GARMENT_CATEGORIES,
  HEM_LENGTHS,
  SLEEVE_LENGTHS,
  type SleeveLength,
  type TopLikeCategory,
} from '../garments/schema';
import {
  ANCHOR_NAMES,
  cropToAlphaBBox,
  SKIRT_ANCHOR_NAMES,
  suggestAnchors,
  suggestPantsAnchors,
} from '@practics/tryon-core';
import type { GarmentAnchors, HemLength, PipelineResult, Point, SkirtAnchors } from '@practics/tryon-core';

interface Draft {
  image: ImageBitmap;
  anchors: AnchorMap;
  /** Retained so switching category (top ↔ pants) can re-run the matching anchor suggestion without reprocessing the photo. */
  alphaData: Uint8ClampedArray;
  width: number;
  height: number;
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

// Everything except lehenga-choli (a two-piece ensemble needs its own flow).
const UPLOAD_CATEGORIES = GARMENT_CATEGORIES.filter(
  (c): c is TopLikeCategory | 'pants' => c !== 'lehenga-choli',
);

type UploadCategory = TopLikeCategory | 'pants';

/** Typical hem length per category — applied when the user changes the
 * category select, since length (not category) is what actually drives how
 * far the garment hangs on the body when rendered (see
 * pipeline/anchorMapping.ts computeHem). Still editable afterward. */
const CATEGORY_DEFAULT_LENGTH: Record<UploadCategory, HemLength> = {
  top: 'hip',
  shirt: 'hip',
  tshirt: 'hip',
  kurti: 'knee',
  dress: 'knee',
  saree: 'ankle',
  pants: 'ankle',
};

/**
 * Suggests category + hem length from the cropped garment silhouette's
 * proportions: a top is roughly as tall as it is wide, a knee-length dress
 * is noticeably taller, a full-length gown taller still. A starting point
 * only — the selects stay editable, and getting `length` right matters
 * more than `category` (length is what makes it render as a dress rather
 * than stopping at the hips). Pants are never auto-suggested — the user
 * picks the category, which re-runs the pants anchor suggestion.
 */
function suggestMeta(w: number, h: number): { category: UploadCategory; length: HemLength } {
  const ratio = h / Math.max(1, w);
  if (ratio >= 1.9) return { category: 'dress', length: 'ankle' };
  if (ratio >= 1.3) return { category: 'dress', length: 'knee' };
  return { category: 'top', length: 'hip' };
}

function fallbackTopAnchors(w: number, h: number): AnchorMap {
  return {
    shoulderL: [w * 0.2, h * 0.05],
    shoulderR: [w * 0.8, h * 0.05],
    waistL: [w * 0.25, h * 0.55],
    waistR: [w * 0.75, h * 0.55],
    hemL: [w * 0.15, h * 0.95],
    hemR: [w * 0.85, h * 0.95],
  };
}

function fallbackPantsAnchors(w: number, h: number): AnchorMap {
  return {
    waistL: [w * 0.2, h * 0.05],
    waistR: [w * 0.8, h * 0.05],
    hemL: [w * 0.1, h * 0.95],
    hemR: [w * 0.9, h * 0.95],
  };
}

const TOP_EDGES: readonly (readonly [string, string])[] = [
  ['shoulderL', 'shoulderR'],
  ['shoulderL', 'waistL'],
  ['waistL', 'hemL'],
  ['shoulderR', 'waistR'],
  ['waistR', 'hemR'],
  ['waistL', 'waistR'],
  ['hemL', 'hemR'],
];

const PANTS_EDGES: readonly (readonly [string, string])[] = [
  ['waistL', 'waistR'],
  ['waistL', 'hemL'],
  ['waistR', 'hemR'],
];

/** Which anchors the editor shows/drags for the current category + sleeves. */
function editorSpec(category: UploadCategory, sleeves: SleeveLength) {
  if (category === 'pants') return { names: [...SKIRT_ANCHOR_NAMES] as string[], edges: PANTS_EDGES };
  const names: string[] = [...ANCHOR_NAMES];
  const edges = [...TOP_EDGES];
  if (sleeves === 'half') {
    names.push('cuffL', 'cuffR');
    edges.push(['shoulderL', 'cuffL'], ['shoulderR', 'cuffR']);
  } else if (sleeves === 'full') {
    names.push('elbowL', 'cuffL', 'elbowR', 'cuffR');
    edges.push(['shoulderL', 'elbowL'], ['elbowL', 'cuffL'], ['shoulderR', 'elbowR'], ['elbowR', 'cuffR']);
  }
  return { names, edges };
}

/**
 * Ensures the draft's anchors match the sleeve selection: sleeve anchors
 * appear (with geometric defaults hung off the shoulder anchors — the
 * live preview makes correcting them fast) when sleeves demand them, and
 * disappear when they don't (a stale cuff from a previous selection must
 * not silently ship in the saved garment).
 */
function applySleeveShape(anchors: AnchorMap, sleeves: SleeveLength): AnchorMap {
  const out: AnchorMap = { ...anchors };
  const wanted = sleeves === 'full' ? ['elbowL', 'cuffL', 'elbowR', 'cuffR'] : sleeves === 'half' ? ['cuffL', 'cuffR'] : [];
  for (const name of ['elbowL', 'cuffL', 'elbowR', 'cuffR']) {
    if (!wanted.includes(name)) delete out[name];
  }
  if (wanted.length === 0) return out;

  const sL = anchors.shoulderL;
  const sR = anchors.shoulderR;
  const hem = anchors.hemL;
  if (!sL || !sR || !hem) return out;
  const w = sR[0] - sL[0];
  const h = Math.max(1, hem[1] - sL[1]);
  const defaults: Record<string, Point> = {
    elbowL: [sL[0] - w * 0.12, sL[1] + h * 0.45],
    elbowR: [sR[0] + w * 0.12, sR[1] + h * 0.45],
    cuffL: sleeves === 'full' ? [sL[0] - w * 0.15, sL[1] + h * 0.8] : [sL[0] - w * 0.1, sL[1] + h * 0.3],
    cuffR: sleeves === 'full' ? [sR[0] + w * 0.15, sR[1] + h * 0.8] : [sR[0] + w * 0.1, sR[1] + h * 0.3],
  };
  for (const name of wanted) {
    if (!out[name]) out[name] = defaults[name];
  }
  return out;
}

/** Re-runs the matching auto-suggestion when the category family (top ↔ pants) changes. */
function suggestFor(draft: Draft, category: UploadCategory, sleeves: SleeveLength): AnchorMap {
  if (category === 'pants') {
    return (
      (suggestPantsAnchors(draft.alphaData, draft.width, draft.height) as AnchorMap | null) ??
      fallbackPantsAnchors(draft.width, draft.height)
    );
  }
  const base =
    (suggestAnchors(draft.alphaData, draft.width, draft.height) as AnchorMap | null) ??
    fallbackTopAnchors(draft.width, draft.height);
  return applySleeveShape(base, sleeves);
}

interface Props {
  onGarmentAdded: (garment: StoredUserGarment) => Promise<unknown>;
  /** Photo-mode person + pipeline result for the render-while-you-drag preview; null when no photo is loaded (the preview is skipped with a hint). */
  previewImage: ImageBitmap | null;
  previewResult: PipelineResult | null;
}

/**
 * User garment upload flow (Phase A4, see docs/plan-3d-garment-assets.md
 * §5.2): photo → in-browser background removal → auto-crop → auto-suggest
 * anchors → drag-adjust with a live try-on preview → optional back photo
 * (same flow) → save. Supports top-like categories (with optional sleeve
 * anchors per the sleeves selection) and pants (4-point per-leg anchors).
 * All client-side; the matting model downloads lazily on first use of this
 * panel, independent of (and lazier than) the depth model.
 */
export function GarmentUpload({ onGarmentAdded, previewImage, previewResult }: Props) {
  const matting = useMatting();
  const [step, setStep] = useState<UploadStep>({ kind: 'closed' });
  const [category, setCategory] = useState<UploadCategory>('top');
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

  const isPants = category === 'pants';
  const spec = editorSpec(category, isPants ? 'sleeveless' : sleeves);
  const lengthOptions = isPants ? HEM_LENGTHS.filter((l) => l !== 'hip') : HEM_LENGTHS;

  const processPhoto = async (file: File): Promise<Draft | null> => {
    const raw = await createImageBitmap(file);
    const matted = await matting.removeBackground(raw); // transfers `raw`
    const cropped = await cropToAlphaBBox(matted);
    matted.close();
    if (!cropped) {
      setError("couldn't detect a garment in that photo — try one with a plain background");
      return null;
    }
    return {
      image: cropped.bitmap,
      anchors: {},
      alphaData: cropped.alphaData,
      width: cropped.width,
      height: cropped.height,
    };
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
      front.anchors = suggestFor(front, suggested.category, sleeves);
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
      back.anchors = suggestFor(back, category, sleeves);
      setStep({ kind: 'back-edit', front, back });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'back-select', front });
    }
  };

  /** Applies a category change to the open draft(s): new suggestion + shape rules. */
  const changeCategory = (next: UploadCategory) => {
    setCategory(next);
    setLength(CATEGORY_DEFAULT_LENGTH[next]);
    setStep((prev) => {
      if (prev.kind === 'front-edit') {
        return { ...prev, front: { ...prev.front, anchors: suggestFor(prev.front, next, sleeves) } };
      }
      if (prev.kind === 'back-edit') {
        return {
          ...prev,
          front: { ...prev.front, anchors: suggestFor(prev.front, next, sleeves) },
          back: { ...prev.back, anchors: suggestFor(prev.back, next, sleeves) },
        };
      }
      return prev;
    });
  };

  /** Applies a sleeves change to the open draft(s): add/remove sleeve anchors. */
  const changeSleeves = (next: SleeveLength) => {
    setSleeves(next);
    setStep((prev) => {
      if (prev.kind === 'front-edit') {
        return { ...prev, front: { ...prev.front, anchors: applySleeveShape(prev.front.anchors, next) } };
      }
      if (prev.kind === 'back-edit') {
        return {
          ...prev,
          front: { ...prev.front, anchors: applySleeveShape(prev.front.anchors, next) },
          back: { ...prev.back, anchors: applySleeveShape(prev.back.anchors, next) },
        };
      }
      return prev;
    });
  };

  /** Narrows a draft's loose AnchorMap to the strict shape the store expects. */
  const pickAnchors = (anchors: AnchorMap): GarmentAnchors | SkirtAnchors => {
    if (isPants) {
      const out: Partial<Record<string, Point>> = {};
      for (const name of SKIRT_ANCHOR_NAMES) out[name] = anchors[name];
      return out as SkirtAnchors;
    }
    const out: Partial<Record<string, Point>> = {};
    for (const name of spec.names) {
      if (anchors[name]) out[name] = anchors[name];
    }
    return out as GarmentAnchors;
  };

  const save = async (front: Draft, back: Draft | undefined) => {
    setStep({ kind: 'saving', front, back });
    try {
      const [frontBlob, backBlob] = await Promise.all([
        bitmapToBlob(front.image),
        back ? bitmapToBlob(back.image) : Promise.resolve(null),
      ]);
      const stored: StoredUserGarment = {
        id: `${USER_GARMENT_ID_PREFIX}${crypto.randomUUID()}`,
        category,
        front: { imageBlob: frontBlob, anchors: pickAnchors(front.anchors) },
        ...(backBlob && !isPants
          ? { back: { imageBlob: backBlob, anchors: pickAnchors(back!.anchors) } }
          : {}),
        meta: { sleeves: isPants ? 'sleeveless' : sleeves, length },
        createdAt: Date.now(),
      };
      await onGarmentAdded(stored);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep({ kind: 'front-edit', front });
    }
  };

  const preview = (draft: Draft) =>
    previewImage && previewResult ? (
      <TryOnPreview
        person={previewImage}
        result={previewResult}
        garmentImage={draft.image}
        anchors={draft.anchors}
        category={category}
        hemLength={length}
        sleeves={isPants ? 'sleeveless' : sleeves}
      />
    ) : (
      <p className="hint anchor-preview-hint">
        tip: pick a test photo in the main view first to see a live try-on preview while you drag.
      </p>
    );

  if (step.kind === 'closed') {
    return (
      <div className="controls">
        <button onClick={open}>upload your own garment</button>
      </div>
    );
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Upload your own garment">
      <div className="modal-content garment-upload">
      <div className="controls">
        <span className="hint">upload your own garment</span>
        <button onClick={close}>✕ close</button>
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
            automatically, keeping just the garment). Tops, dresses, kurtis, and pants all work.
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
            drag the yellow markers to fine-tune the anchors — the preview updates as you drag.
            "length" decides how far it hangs on the body (hip ≈ top, knee/ankle ≈ dress/pants).
          </p>
          <div className="anchor-edit-row">
            <AnchorEditor
              image={step.front.image}
              anchors={step.front.anchors}
              names={spec.names}
              edges={spec.edges}
              onChange={(anchors) => setStep({ kind: 'front-edit', front: { ...step.front, anchors } })}
            />
            {preview(step.front)}
          </div>
          <div className="controls">
            <label>
              category{' '}
              <select value={category} onChange={(e) => changeCategory(e.target.value as UploadCategory)}>
                {UPLOAD_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {!isPants && (
              <label>
                sleeves{' '}
                <select value={sleeves} onChange={(e) => changeSleeves(e.target.value as SleeveLength)}>
                  {SLEEVE_LENGTHS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              length{' '}
              <select value={length} onChange={(e) => setLength(e.target.value as HemLength)}>
                {lengthOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="controls">
            {isPants ? (
              // Pants have no back-photo support (see schema.ts PantsGarment).
              <button onClick={() => void save(step.front, undefined)}>save</button>
            ) : (
              <button onClick={() => setStep({ kind: 'back-select', front: step.front })}>
                continue
              </button>
            )}
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
            names={spec.names}
            edges={spec.edges}
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
