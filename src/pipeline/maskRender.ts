/**
 * Upscales the low-res segmentation mask to full frame size with a slight
 * blur to feather edges (see CLAUDE.md gotcha: hard halo artifacts
 * otherwise). Shared by the debug overlay tint and the garment-compositing
 * clip mask so both apply identical feathering.
 */

type Canvas2DContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** White fill, alpha = person confidence, feathered, sized to (width, height). */
export function renderFeatheredMask(
  mask: ImageBitmap,
  width: number,
  height: number,
  blurPx?: number,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('renderFeatheredMask: no 2d context');
  const blur = blurPx ?? Math.max(1, Math.round(width / 400));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(mask, 0, 0, width, height);
  ctx.filter = 'none';
  return canvas;
}

/** Tints a feathered mask canvas with a solid color, alpha carrying confidence. */
export function tintMask(maskCanvas: OffscreenCanvas, color: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(maskCanvas.width, maskCanvas.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('tintMask: no 2d context');
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Clips `source` to the feathered mask's silhouette (destination-in). */
export function clipToMask(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maskCanvas: OffscreenCanvas,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
  const ctx = canvas.getContext('2d') as Canvas2DContext | null;
  if (!ctx) throw new Error('clipToMask: no 2d context');
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  return canvas;
}
