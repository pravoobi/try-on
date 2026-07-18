import { useEffect, useRef } from 'react';
import { renderPantsTryOn, renderTryOn } from '@practics/tryon-core';
import type {
  GarmentAnchors,
  HemLength,
  PipelineResult,
  SkirtAnchors,
  SleeveLength,
} from '@practics/tryon-core';
import type { AnchorMap } from './AnchorEditor';
import { tryOnConfig } from './DebugCanvas';

/** A close()d ImageBitmap is "detached" and reports width 0 — drawing it throws. */
function isDetached(source: { width: number } | null | undefined): boolean {
  return !!source && source.width === 0;
}

interface Props {
  /** The person photo the draft garment is previewed on. */
  person: ImageBitmap;
  /** That photo's pipeline result (keypoints + mask). */
  result: PipelineResult;
  garmentImage: ImageBitmap;
  anchors: AnchorMap;
  category: string;
  hemLength: HemLength;
  sleeves: SleeveLength;
}

/**
 * Render-while-you-drag preview for the upload flow's anchor editor: the
 * draft garment composited live onto the currently loaded photo-mode
 * person, re-rendered as anchors move. This is what makes anchor
 * correction fast — you see the garment snap into place instead of
 * save-and-check round-trips. Re-renders are coalesced with a zero-delay
 * timeout rather than requestAnimationFrame: rAF is throttled or paused
 * entirely while a tab is backgrounded/hidden per spec, which would leave
 * the preview silently stale if the editor dialog loses tab focus mid-drag
 * (e.g. an alt-tab); setTimeout has no such visibility dependency.
 * Harmonization/shading are deliberately off here: the preview's job is
 * anchor placement, not final-look fidelity.
 */
export function TryOnPreview({ person, result, garmentImage, anchors, category, hemLength, sleeves }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // The person photo/result belong to the app's photo-mode state, which
      // can be replaced (and its bitmaps closed) while this dialog is open —
      // skip the paint rather than throw out of the effect.
      if (isDetached(person) || isDetached(result.maskBitmap) || isDetached(garmentImage)) return;
      canvas.width = person.width;
      canvas.height = person.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (category === 'pants') {
        renderPantsTryOn(ctx, {
          frame: person,
          maskBitmap: result.maskBitmap,
          keypoints: result.keypoints,
          garmentImage,
          garmentAnchors: anchors as unknown as SkirtAnchors,
          hemLength,
          config: tryOnConfig,
        });
      } else {
        renderTryOn(ctx, {
          frame: person,
          maskBitmap: result.maskBitmap,
          keypoints: result.keypoints,
          garmentImage,
          garmentAnchors: anchors as unknown as GarmentAnchors,
          hemLength,
          sleeves,
          config: tryOnConfig,
        });
      }
    }, 0);
    return () => clearTimeout(id);
  }, [person, result, garmentImage, anchors, category, hemLength, sleeves]);

  return (
    <div className="anchor-preview">
      <span className="hint">live preview</span>
      <canvas ref={canvasRef} />
    </div>
  );
}
