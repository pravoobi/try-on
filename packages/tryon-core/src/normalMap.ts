/**
 * Converts a grayscale depth/heightmap into a tangent-space normal map via
 * central-difference gradients — used to relight a flat garment photo
 * against an estimated scene light (Phase A3, see
 * docs/plan-3d-garment-assets.md §5.4 "Normal-map relighting").
 */

/**
 * `alphaSource` supplies the output's alpha channel (the garment's own
 * silhouette) rather than deriving one from the heightmap — `depth` and
 * `alphaSource` are expected to be the same image (a depth-estimation
 * result and the garment photo it was computed from), so the normal map
 * ends up with identical coverage to the garment texture it will be
 * warped and composited alongside.
 */
export function depthToNormalMap(
  depth: CanvasImageSource & { width: number; height: number },
  alphaSource: CanvasImageSource & { width: number; height: number },
  strength: number,
): OffscreenCanvas {
  const w = depth.width;
  const h = depth.height;

  const depthCanvas = new OffscreenCanvas(w, h);
  const depthCtx = depthCanvas.getContext('2d');
  if (!depthCtx) throw new Error('depthToNormalMap: no 2d context');
  depthCtx.drawImage(depth, 0, 0);
  const depthData = depthCtx.getImageData(0, 0, w, h).data;

  const alphaCanvas = new OffscreenCanvas(w, h);
  const alphaCtx = alphaCanvas.getContext('2d');
  if (!alphaCtx) throw new Error('depthToNormalMap: no 2d context');
  alphaCtx.drawImage(alphaSource, 0, 0, w, h);
  const alphaData = alphaCtx.getImageData(0, 0, w, h).data;

  const sampleDepth = (x: number, y: number): number => {
    const cx = Math.min(w - 1, Math.max(0, x));
    const cy = Math.min(h - 1, Math.max(0, y));
    return depthData[(cy * w + cx) * 4];
  };

  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dzdx = (sampleDepth(x + 1, y) - sampleDepth(x - 1, y)) / 2;
      const dzdy = (sampleDepth(x, y + 1) - sampleDepth(x, y - 1)) / 2;
      let nx = -dzdx * strength;
      let ny = -dzdy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const i = (y * w + x) * 4;
      out[i] = Math.round((nx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[i + 3] = alphaData[i + 3];
    }
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('depthToNormalMap: no 2d context');
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
  return canvas;
}
