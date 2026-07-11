import { useEffect, useRef } from 'react';
import { config } from '../config';
import { renderFeatheredMask, tintMask } from '../pipeline/maskRender';
import { renderLehengaCholiTryOn, renderTryOn, type TryOnStatus } from '../pipeline/compositor';
import type {
  GarmentAnchors,
  HemLength,
  KeypointName,
  PipelineResult,
  SkirtAnchors,
} from '../pipeline/types';
import { SKELETON_EDGES } from '../pipeline/types';

export type GarmentOverlay =
  | { kind: 'single'; image: ImageBitmap; anchors: GarmentAnchors; hemLength: HemLength }
  | {
      kind: 'lehenga-choli';
      choliImage: ImageBitmap;
      choliAnchors: GarmentAnchors;
      lehengaImage: ImageBitmap;
      lehengaAnchors: SkirtAnchors;
      skirtLength: HemLength;
    };

interface Props {
  image: ImageBitmap;
  result: PipelineResult | null;
  showMask: boolean;
  showSkeleton: boolean;
  garment?: GarmentOverlay | null;
  onTryOnStatus?: (status: TryOnStatus | null) => void;
}

/** Draws the photo, an optional try-on garment layer, and debug overlays (mask tint, skeleton). */
export function DebugCanvas({ image, result, showMask, showSkeleton, garment, onTryOnStatus }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = image.width;
    const h = image.height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let tryOnStatus: TryOnStatus | null = null;
    if (garment && result) {
      if (garment.kind === 'single') {
        tryOnStatus = renderTryOn(ctx, {
          frame: image,
          maskBitmap: result.maskBitmap,
          keypoints: result.keypoints,
          garmentImage: garment.image,
          garmentAnchors: garment.anchors,
          hemLength: garment.hemLength,
        });
      } else {
        tryOnStatus = renderLehengaCholiTryOn(ctx, {
          frame: image,
          maskBitmap: result.maskBitmap,
          keypoints: result.keypoints,
          choliImage: garment.choliImage,
          choliAnchors: garment.choliAnchors,
          lehengaImage: garment.lehengaImage,
          lehengaAnchors: garment.lehengaAnchors,
          skirtLength: garment.skirtLength,
        });
      }
    } else {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0);
    }
    onTryOnStatus?.(tryOnStatus);

    if (result && showMask) {
      const tinted = tintMask(renderFeatheredMask(result.maskBitmap, w, h), '#2dd4bf');
      ctx.globalAlpha = config.maskOpacity;
      ctx.drawImage(tinted, 0, 0);
      ctx.globalAlpha = 1;
    }

    if (result && showSkeleton) {
      const byName = new Map<KeypointName, (typeof result.keypoints)[number]>();
      for (const kp of result.keypoints) byName.set(kp.name, kp);
      const lw = Math.max(2, Math.round(w / 320));

      ctx.lineWidth = lw;
      ctx.strokeStyle = '#f472b6';
      for (const [a, b] of SKELETON_EDGES) {
        const ka = byName.get(a);
        const kb = byName.get(b);
        if (!ka || !kb) continue;
        if (ka.score < config.minKeypointScore || kb.score < config.minKeypointScore) continue;
        ctx.beginPath();
        ctx.moveTo(ka.x, ka.y);
        ctx.lineTo(kb.x, kb.y);
        ctx.stroke();
      }

      for (const kp of result.keypoints) {
        const confident = kp.score >= config.minKeypointScore;
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, lw * 1.6, 0, Math.PI * 2);
        if (confident) {
          ctx.fillStyle = '#facc15';
          ctx.fill();
        } else {
          ctx.strokeStyle = '#9ca3af';
          ctx.lineWidth = Math.max(1, lw / 2);
          ctx.stroke();
          ctx.lineWidth = lw;
          ctx.strokeStyle = '#f472b6';
        }
      }
    }
  }, [image, result, showMask, showSkeleton, garment, onTryOnStatus]);

  return <canvas ref={ref} className="debug-canvas" />;
}
