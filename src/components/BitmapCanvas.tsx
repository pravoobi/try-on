import { useEffect, useRef } from 'react';

interface Props {
  bitmap: ImageBitmap;
  className?: string;
}

/** Draws a single ImageBitmap into a canvas sized to match it — the plain
 * <img> tag can't take an ImageBitmap directly. */
export function BitmapCanvas({ bitmap, className }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(bitmap, 0, 0);
  }, [bitmap]);

  return <canvas ref={ref} className={className} />;
}
