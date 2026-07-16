import { useEffect, useRef } from 'react';
import { ANCHOR_NAMES, type AnchorName, type GarmentAnchors } from '@practics/tryon-core';

/** Visual guide lines only (not used for warping) — same shape annotate.html draws. */
const ANCHOR_EDGES: readonly (readonly [AnchorName, AnchorName])[] = [
  ['shoulderL', 'shoulderR'],
  ['shoulderL', 'waistL'],
  ['waistL', 'hemL'],
  ['shoulderR', 'waistR'],
  ['waistR', 'hemR'],
  ['waistL', 'waistR'],
  ['hemL', 'hemR'],
];

const MAX_W = 420;
const MAX_H = 560;
const HIT_RADIUS = 14;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface Props {
  image: ImageBitmap;
  anchors: GarmentAnchors;
  onChange: (anchors: GarmentAnchors) => void;
}

/**
 * Draggable 6-anchor overlay over a garment image (Phase A4, see
 * docs/plan-3d-garment-assets.md §5.2) — ports tools/annotate.html's
 * click/drag interaction to React, used to let the user fine-tune the
 * auto-suggested anchors (pipeline/autoAnchor.ts). CLAUDE.md: "anchor
 * quality dominates output quality" — auto-suggestion alone isn't enough.
 */
export function AnchorEditor({ image, anchors, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scaleRef = useRef(1);
  const draggingRef = useRef<AnchorName | null>(null);

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
    for (const [a, b] of ANCHOR_EDGES) {
      const pa = anchors[a];
      const pb = anchors[b];
      ctx.beginPath();
      ctx.moveTo(pa[0] * scale, pa[1] * scale);
      ctx.lineTo(pb[0] * scale, pb[1] * scale);
      ctx.stroke();
    }

    for (const name of ANCHOR_NAMES) {
      const p = anchors[name];
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
  }, [image, anchors]);

  const hitTest = (cx: number, cy: number): AnchorName | null => {
    const scale = scaleRef.current;
    let best: AnchorName | null = null;
    let bestDist = HIT_RADIUS;
    for (const name of ANCHOR_NAMES) {
      const p = anchors[name];
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
