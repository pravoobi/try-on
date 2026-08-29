/**
 * A downscaled PNG data URL of a canvas — used to freeze the composited
 * try-on preview into a saved look (see hooks/useLooks.ts). Downscaled
 * because the source canvas is full photo resolution and a handful of
 * full-res data URLs held in memory adds up fast; the looks tray and the
 * comparison view both display small.
 */
export function snapshotCanvas(source: HTMLCanvasElement, maxWidth = 400): string {
  if (source.width === 0 || source.height === 0) {
    throw new Error('canvas has nothing rendered yet');
  }
  const scale = Math.min(1, maxWidth / source.width);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for snapshot');
  ctx.drawImage(source, 0, 0, w, h);
  return off.toDataURL('image/png');
}
