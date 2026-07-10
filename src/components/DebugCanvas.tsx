import { useEffect, useRef } from 'react';
import { config } from '../config';
import { SKELETON_EDGES, type KeypointName, type PipelineResult } from '../pipeline/types';

interface Props {
  image: ImageBitmap;
  result: PipelineResult | null;
  showMask: boolean;
  showSkeleton: boolean;
}

/** Draws the photo with the segmentation mask tint and keypoint skeleton. */
export function DebugCanvas({ image, result, showMask, showSkeleton }: Props) {
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

    ctx.drawImage(image, 0, 0);

    if (result && showMask) {
      // Tint the low-res mask: bilinear upscale + slight blur to feather
      // edges (per CLAUDE.md: avoids hard halo artifacts), colored via
      // source-in, alpha carries confidence.
      const tint = document.createElement('canvas');
      tint.width = w;
      tint.height = h;
      const tctx = tint.getContext('2d');
      if (tctx) {
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = 'high';
        tctx.filter = `blur(${Math.max(1, Math.round(w / 400))}px)`;
        tctx.drawImage(result.maskBitmap, 0, 0, w, h);
        tctx.filter = 'none';
        tctx.globalCompositeOperation = 'source-in';
        tctx.fillStyle = '#2dd4bf';
        tctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = config.maskOpacity;
        ctx.drawImage(tint, 0, 0);
        ctx.globalAlpha = 1;
      }
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
  }, [image, result, showMask, showSkeleton]);

  return <canvas ref={ref} className="debug-canvas" />;
}
