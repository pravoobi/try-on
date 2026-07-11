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

/**
 * Returns a copy of the mask that fades to fully opaque below `openY` and
 * back to fully transparent below `cutY` (each blending over `blendPx`).
 * The person mask is the right garment clip for fitted fabric — it keeps
 * the top off the background — but wrong below the waist for skirts and
 * dress hems: a hanging skirt is the OUTERMOST silhouette, meant to drape
 * over the background and cover the gap between the legs. Clipping it to
 * the body turns a skirt into leggings. The cut below the hem matters too:
 * nothing below the hem anchors is fabric, and background-removed garment
 * photos often carry junk down there (the original model's shoes/feet)
 * that the body clip used to hide.
 */
export function openMaskBelow(
  maskCanvas: OffscreenCanvas,
  openY: number,
  openBlendPx: number,
  cutY: number,
  cutBlendPx: number,
): OffscreenCanvas {
  const { width, height } = maskCanvas;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('openMaskBelow: no 2d context');
  const openBlend = Math.max(1, openBlendPx);
  const cutBlend = Math.max(1, cutBlendPx);
  ctx.drawImage(maskCanvas, 0, 0);

  const open = ctx.createLinearGradient(0, openY, 0, openY + openBlend);
  open.addColorStop(0, 'rgba(255,255,255,0)');
  open.addColorStop(1, 'rgba(255,255,255,1)');
  // White band spans through the cut's blend zone so the destination-out
  // fade below is what tapers it, over background and person alike.
  ctx.fillStyle = open;
  ctx.fillRect(0, openY, width, Math.max(0, cutY + cutBlend - openY));

  const cut = ctx.createLinearGradient(0, cutY, 0, cutY + cutBlend);
  cut.addColorStop(0, 'rgba(0,0,0,0)');
  cut.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = cut;
  ctx.fillRect(0, cutY, width, height - cutY);
  ctx.globalCompositeOperation = 'source-over';
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
