import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DebugCanvas } from './components/DebugCanvas';
import { GarmentPicker } from './components/GarmentPicker';
import { config } from './config';
import type { Garment } from './garments/schema';
import { useGarmentCatalog } from './hooks/useGarmentCatalog';
import { usePipeline } from './hooks/usePipeline';
import type { TryOnStatus } from './pipeline/compositor';
import type { Accelerator, PipelineResult } from './pipeline/types';

export default function App() {
  const [accelerator, setAccelerator] = useState<Accelerator>('webgpu');
  const pipeline = usePipeline(accelerator);
  const catalog = useGarmentCatalog();
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showMask, setShowMask] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [selectedGarment, setSelectedGarment] = useState<Garment | null>(null);
  const [garmentBitmap, setGarmentBitmap] = useState<ImageBitmap | null>(null);
  const [garmentError, setGarmentError] = useState<string | null>(null);
  const [tryOnStatus, setTryOnStatus] = useState<TryOnStatus | null>(null);
  const imageRef = useRef<ImageBitmap | null>(null);
  const resultRef = useRef<PipelineResult | null>(null);
  const garmentBitmapRef = useRef<ImageBitmap | null>(null);

  const run = useCallback(
    async (bitmap: ImageBitmap) => {
      setProcessing(true);
      setRunError(null);
      try {
        // The worker consumes (transfers) its copy; keep ours for rendering.
        const copy = await createImageBitmap(bitmap);
        const res = await pipeline.process(copy);
        resultRef.current?.maskBitmap.close();
        resultRef.current = res;
        setResult(res);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err));
      } finally {
        setProcessing(false);
      }
    },
    [pipeline.process],
  );

  const loadBitmap = useCallback(
    async (blob: Blob) => {
      try {
        const bitmap = await createImageBitmap(blob);
        imageRef.current?.close();
        imageRef.current = bitmap;
        resultRef.current?.maskBitmap.close();
        resultRef.current = null;
        setResult(null);
        setImage(bitmap);
        await run(bitmap);
      } catch (err) {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    },
    [run],
  );

  // Re-process the current photo when the worker (re)becomes ready,
  // e.g. after switching accelerator.
  useEffect(() => {
    if (pipeline.status === 'ready' && imageRef.current) {
      void run(imageRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.status, run]);

  // Load the selected garment's PNG into an ImageBitmap for the compositor.
  useEffect(() => {
    if (!selectedGarment) {
      garmentBitmapRef.current?.close();
      garmentBitmapRef.current = null;
      setGarmentBitmap(null);
      setGarmentError(null);
      return;
    }
    let cancelled = false;
    setGarmentError(null);
    void (async () => {
      try {
        const res = await fetch(selectedGarment.image);
        if (!res.ok) throw new Error(`fetch ${selectedGarment.image} failed: ${res.status}`);
        const bitmap = await createImageBitmap(await res.blob());
        if (cancelled) {
          bitmap.close();
          return;
        }
        garmentBitmapRef.current?.close();
        garmentBitmapRef.current = bitmap;
        setGarmentBitmap(bitmap);
      } catch (err) {
        if (!cancelled) setGarmentError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedGarment]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadBitmap(file);
    e.target.value = '';
  };

  const onTestPhoto = async (name: string) => {
    setRunError(null);
    const res = await fetch(`/test-photos/${name}`);
    if (!res.ok) {
      setRunError(`could not load ${name} — run \`npm run fetch-test-photos\` first`);
      return;
    }
    void loadBitmap(await res.blob());
  };

  const garmentOverlay = useMemo(
    () =>
      selectedGarment && garmentBitmap
        ? { image: garmentBitmap, anchors: selectedGarment.anchors, hemLength: selectedGarment.meta.length }
        : null,
    [selectedGarment, garmentBitmap],
  );

  return (
    <div className="app">
      <header>
        <h1>Virtual Try-On — Phase 2: garment overlay</h1>
        <p className="status">
          {pipeline.status === 'loading' && 'Loading models…'}
          {pipeline.status === 'error' && <span className="error">init failed: {pipeline.error}</span>}
          {pipeline.status === 'ready' && (
            <>
              backend: <strong className={pipeline.backend === 'webgpu' ? 'ok' : 'warn'}>
                {pipeline.backend}
              </strong>
              {' · '}init {Math.round(pipeline.initMs ?? 0)} ms
              {result && (
                <>
                  {' · '}seg {result.timings.segmentMs.toFixed(1)} ms
                  {' · '}pose {result.timings.poseMs.toFixed(1)} ms
                </>
              )}
            </>
          )}
        </p>
      </header>

      <div className="controls">
        <label>
          accelerator{' '}
          <select
            value={accelerator}
            onChange={(e) => setAccelerator(e.target.value as Accelerator)}
          >
            <option value="webgpu">webgpu</option>
            <option value="wasm">wasm (cpu)</option>
          </select>
        </label>
        <label>
          <input type="file" accept="image/*" onChange={onFile} disabled={pipeline.status !== 'ready'} />
        </label>
        <label>
          <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
          mask
        </label>
        <label>
          <input
            type="checkbox"
            checked={showSkeleton}
            onChange={(e) => setShowSkeleton(e.target.checked)}
          />
          skeleton
        </label>
      </div>

      <div className="controls">
        <span className="hint">test photos:</span>
        {config.testPhotos.map((name) => (
          <button
            key={name}
            onClick={() => void onTestPhoto(name)}
            disabled={pipeline.status !== 'ready'}
          >
            {name.replace(/\.(jpg|png)$/, '')}
          </button>
        ))}
      </div>

      <div className="controls">
        <span className="hint">garment:</span>
        {catalog.status === 'loading' && <span className="hint">loading catalog…</span>}
        {catalog.status === 'error' && <span className="error">catalog error: {catalog.error}</span>}
        {catalog.status === 'ready' && (
          <GarmentPicker
            garments={catalog.garments}
            selectedId={selectedGarment?.id ?? null}
            onSelect={setSelectedGarment}
          />
        )}
      </div>

      {runError && <p className="error">{runError}</p>}
      {garmentError && <p className="error">garment load failed: {garmentError}</p>}
      {processing && <p className="hint">running inference…</p>}
      {tryOnStatus === 'pose-not-anchorable' && (
        <p className="hint">
          torso not confidently detected — garment can't be anchored on this photo/pose.
        </p>
      )}

      <main>
        {image ? (
          <DebugCanvas
            image={image}
            result={result}
            showMask={showMask}
            showSkeleton={showSkeleton}
            garment={garmentOverlay}
            onTryOnStatus={setTryOnStatus}
          />
        ) : (
          <p className="hint">Upload a photo or pick a test photo to run the pipeline.</p>
        )}
      </main>
    </div>
  );
}
