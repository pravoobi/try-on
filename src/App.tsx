import { useCallback, useEffect, useRef, useState } from 'react';
import { DebugCanvas } from './components/DebugCanvas';
import { config } from './config';
import { usePipeline } from './hooks/usePipeline';
import type { Accelerator, PipelineResult } from './pipeline/types';

export default function App() {
  const [accelerator, setAccelerator] = useState<Accelerator>('webgpu');
  const pipeline = usePipeline(accelerator);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showMask, setShowMask] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const imageRef = useRef<ImageBitmap | null>(null);
  const resultRef = useRef<PipelineResult | null>(null);

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

  return (
    <div className="app">
      <header>
        <h1>Virtual Try-On — Phase 1: pipeline proof</h1>
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

      {runError && <p className="error">{runError}</p>}
      {processing && <p className="hint">running inference…</p>}

      <main>
        {image ? (
          <DebugCanvas image={image} result={result} showMask={showMask} showSkeleton={showSkeleton} />
        ) : (
          <p className="hint">Upload a photo or pick a test photo to run the pipeline.</p>
        )}
      </main>
    </div>
  );
}
