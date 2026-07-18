import { useEffect, useRef } from 'react';
import type { Point } from '@practics/tryon-core';

/**
 * Loosely-typed anchor dictionary the editor works over — the caller
 * decides which named points exist (6-anchor top, top + sleeve anchors,
 * 4-anchor pants) and passes matching `names`/`edges`; drafts get cast to
 * the strict GarmentAnchors/SkirtAnchors shapes at save time
 * (GarmentUpload.tsx).
 */
export type AnchorMap = Record<string, Point>;

const MAX_W = 420;
const MAX_H = 560;
const HIT_RADIUS = 14;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface Props {
  image: ImageBitmap;
  anchors: AnchorMap;
  /** Which anchors to draw + drag — the shape contract (see AnchorMap). */
  names: readonly string[];
  /** Visual guide lines only (not used for warping) — same idea as tools/annotate.html. */
  edges: readonly (readonly [string, string])[];
  onChange: (anchors: AnchorMap) => void;
}

/**
 * Draggable anchor overlay over a garment image (Phase A4, see
 * docs/plan-3d-garment-assets.md §5.2) — ports tools/annotate.html's
 * click/drag interaction to React, used to let the user fine-tune the
 * auto-suggested anchors (pipeline/autoAnchor.ts). CLAUDE.md: "anchor
 * quality dominates output quality" — auto-suggestion alone isn't enough.
 * Generic over the anchor set: tops, tops-with-sleeves, and pants each
 * pass their own names/edges.
 */
export function AnchorEditor({ image, anchors, names, edges, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scaleRef = useRef(1);
  const draggingRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.min(MAX_W / image.width, MAX_H / image.height, 1);
    scaleRef.current = scale;
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#f472b666';
    ctx.lineWidth = 1.5;
    for (const [a, b] of edges) {
      const pa = anchors[a];
      const pb = anchors[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa[0] * scale, pa[1] * scale);
      ctx.lineTo(pb[0] * scale, pb[1] * scale);
      ctx.stroke();
    }

    for (const name of names) {
      const p = anchors[name];
      if (!p) continue;
      const x = p[0] * scale;
      const y = p[1] * scale;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#facc15';
      ctx.fill();
      ctx.strokeStyle = '#111318';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(name, x + 9, y - 9);
    }
  }, [image, anchors, names, edges]);

  const hitTest = (cx: number, cy: number): string | null => {
    const scale = scaleRef.current;
    let best: string | null = null;
    let bestDist = HIT_RADIUS;
    for (const name of names) {
      const p = anchors[name];
      if (!p) continue;
      const dx = p[0] * scale - cx;
      const dy = p[1] * scale - cy;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  };

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [cx, cy] = pointFromEvent(e);
    const hit = hitTest(cx, cy);
    if (hit) {
      draggingRef.current = hit;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const name = draggingRef.current;
    const canvas = canvasRef.current;
    if (!name || !canvas) return;
    const scale = scaleRef.current;
    const [cx, cy] = pointFromEvent(e);
    const x = clamp(cx, 0, canvas.width) / scale;
    const y = clamp(cy, 0, canvas.height) / scale;
    onChange({ ...anchors, [name]: [x, y] });
  };

  const onPointerUp = () => {
    draggingRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className="anchor-editor"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    />
  );
}
