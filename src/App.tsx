import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assetUrl } from './assetUrl';
import { DebugCanvas, type GarmentOverlay } from './components/DebugCanvas';
import { GarmentPicker } from './components/GarmentPicker';
import { PerfStats } from './components/PerfStats';
import { config } from './config';
import type { Garment } from './garments/schema';
import { useGarmentCatalog } from './hooks/useGarmentCatalog';
import { useLiveTryOn } from './hooks/useLiveTryOn';
import { usePipeline } from './hooks/usePipeline';
import { useWebcam } from './hooks/useWebcam';
import type { TryOnStatus } from './pipeline/compositor';
import type { Accelerator, PipelineResult } from './pipeline/types';

/** The loaded ImageBitmap(s) for the currently-selected garment — one for a
 * single-piece garment, two for a lehenga-choli (choli + lehenga skirt). */
type LoadedGarmentImages =
  | { kind: 'single'; image: ImageBitmap }
  | { kind: 'lehenga-choli'; choliImage: ImageBitmap; lehengaImage: ImageBitmap };

async function fetchBitmap(path: string): Promise<ImageBitmap> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return createImageBitmap(await res.blob());
}

function closeGarmentImages(images: LoadedGarmentImages | null): void {
  if (!images) return;
  if (images.kind === 'single') images.image.close();
  else {
    images.choliImage.close();
    images.lehengaImage.close();
  }
}

type Mode = 'photo' | 'live';

export default function App() {
  const [mode, setMode] = useState<Mode>('photo');
  const [accelerator, setAccelerator] = useState<Accelerator>('webgpu');
  const pipeline = usePipeline(accelerator);
  const catalog = useGarmentCatalog();
  const webcam = useWebcam();
  const live = useLiveTryOn(pipeline, webcam.videoEl, mode === 'live');
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showMask, setShowMask] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [selectedGarment, setSelectedGarment] = useState<Garment | null>(null);
  const [garmentImages, setGarmentImages] = useState<LoadedGarmentImages | null>(null);
  const [garmentError, setGarmentError] = useState<string | null>(null);
  const [tryOnStatus, setTryOnStatus] = useState<TryOnStatus | null>(null);
  const imageRef = useRef<ImageBitmap | null>(null);
  const resultRef = useRef<PipelineResult | null>(null);
  const garmentImagesRef = useRef<LoadedGarmentImages | null>(null);

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
    if (mode === 'photo' && pipeline.status === 'ready' && imageRef.current) {
      void run(imageRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pipeline.status, run]);

  // Start/stop the camera as the mode toggles.
  useEffect(() => {
    setTryOnStatus(null);
    if (mode === 'live') void webcam.start();
    else webcam.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Load the selected garment's PNG(s) into ImageBitmap(s) for the compositor
  // — one image for a single-piece garment, two (choli + lehenga) for a
  // lehenga-choli ensemble.
  useEffect(() => {
    if (!selectedGarment) {
      closeGarmentImages(garmentImagesRef.current);
      garmentImagesRef.current = null;
      setGarmentImages(null);
      setGarmentError(null);
      return;
    }
    let cancelled = false;
    setGarmentError(null);
    void (async () => {
      try {
        const next: LoadedGarmentImages =
          selectedGarment.category === 'lehenga-choli'
            ? {
                kind: 'lehenga-choli',
                choliImage: await fetchBitmap(selectedGarment.choli.image),
                lehengaImage: await fetchBitmap(selectedGarment.lehenga.image),
              }
            : { kind: 'single', image: await fetchBitmap(selectedGarment.image) };
        if (cancelled) {
          closeGarmentImages(next);
          return;
        }
        closeGarmentImages(garmentImagesRef.current);
        garmentImagesRef.current = next;
        setGarmentImages(next);
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
    const res = await fetch(assetUrl(`/test-photos/${name}`));
    if (!res.ok) {
      setRunError(`could not load ${name} — run \`npm run fetch-test-photos\` first`);
      return;
    }
    void loadBitmap(await res.blob());
  };

  const garmentOverlay = useMemo((): GarmentOverlay | null => {
    if (!selectedGarment || !garmentImages) return null;
    if (selectedGarment.category === 'lehenga-choli' && garmentImages.kind === 'lehenga-choli') {
      return {
        kind: 'lehenga-choli',
        choliImage: garmentImages.choliImage,
        choliAnchors: selectedGarment.choli.anchors,
        lehengaImage: garmentImages.lehengaImage,
        lehengaAnchors: selectedGarment.lehenga.anchors,
        skirtLength: selectedGarment.meta.length,
      };
    }
    if (selectedGarment.category !== 'lehenga-choli' && garmentImages.kind === 'single') {
      return {
        kind: 'single',
        image: garmentImages.image,
        anchors: selectedGarment.anchors,
        hemLength: selectedGarment.meta.length,
      };
    }
    // Transient mismatch: selectedGarment just changed shape and the async
    // image load for it hasn't landed yet — skip a render rather than pass
    // mismatched data.
    return null;
  }, [selectedGarment, garmentImages]);

  const displayImage = mode === 'live' ? (live.latest?.frame ?? null) : image;
  const displayResult = mode === 'live' ? (live.latest?.result ?? null) : result;

  return (
    <div className="app">
      <header>
        <h1>Virtual Try-On</h1>
        <p className="status">
          {pipeline.status === 'loading' && 'Loading models…'}
          {pipeline.status === 'error' && <span className="error">init failed: {pipeline.error}</span>}
          {pipeline.status === 'ready' && `init ${Math.round(pipeline.initMs ?? 0)} ms`}
        </p>
      </header>

      {pipeline.status === 'ready' && (
        <PerfStats
          accelerator={accelerator}
          onAcceleratorChange={setAccelerator}
          backend={pipeline.backend}
          fps={mode === 'live' && live.latest ? live.fps : null}
          timings={
            mode === 'photo'
              ? (result?.timings ?? null)
              : (live.latest?.result.timings ?? null)
          }
        />
      )}

      <div className="controls">
        <label>
          mode{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="photo">photo</option>
            <option value="live">live webcam</option>
          </select>
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

      {mode === 'photo' && (
        <div className="controls">
          <label>
            <input type="file" accept="image/*" onChange={onFile} disabled={pipeline.status !== 'ready'} />
          </label>
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
      )}

      {mode === 'live' && (
        <div className="controls">
          <span className="hint">
            {webcam.status === 'requesting' && 'requesting camera access…'}
            {webcam.status === 'ready' && pipeline.status === 'ready' && !live.latest && 'starting live inference…'}
            {webcam.status === 'error' && <span className="error">camera error: {webcam.error}</span>}
          </span>
        </div>
      )}

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
      {live.error && <p className="error">live inference error: {live.error}</p>}
      {garmentError && <p className="error">garment load failed: {garmentError}</p>}
      {processing && <p className="hint">running inference…</p>}
      {tryOnStatus === 'pose-not-anchorable' && (
        <p className="hint">
          torso not confidently detected — garment can't be anchored on this photo/pose.
        </p>
      )}

      <main>
        {displayImage ? (
          <DebugCanvas
            image={displayImage}
            result={displayResult}
            showMask={showMask}
            showSkeleton={showSkeleton}
            garment={garmentOverlay}
            onTryOnStatus={setTryOnStatus}
          />
        ) : (
          <p className="hint">
            {mode === 'photo'
              ? 'Upload a photo or pick a test photo to run the pipeline.'
              : 'Waiting for camera…'}
          </p>
        )}
      </main>
    </div>
  );
}
