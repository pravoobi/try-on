import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assetUrl } from './assetUrl';
import { BitmapCanvas } from './components/BitmapCanvas';
import { DebugCanvas, type GarmentOverlay } from './components/DebugCanvas';
import { GarmentPicker } from './components/GarmentPicker';
import { GarmentUpload } from './components/GarmentUpload';
import { PerfStats } from './components/PerfStats';
import { config } from './config';
import type { Garment, LehengaCholiGarment, PantsGarment, SinglePieceGarment } from './garments/schema';
import { useAdvancedMode } from './hooks/useAdvancedMode';
import { useGarmentCatalog } from './hooks/useGarmentCatalog';
import { useGestureSwipe } from './hooks/useGestureSwipe';
import { useLiveDepth } from './hooks/useLiveDepth';
import { useMatting } from './hooks/useMatting';
import { useLiveTryOn } from './hooks/useLiveTryOn';
import { usePipeline } from './hooks/usePipeline';
import { useTorsoOrientation } from './hooks/useTorsoOrientation';
import { useUserGarments } from './hooks/useUserGarments';
import { useWebcam } from './hooks/useWebcam';
import { mirrorAnchorsLR } from '@practics/tryon-core';
import type { TryOnStatus } from '@practics/tryon-core';
import type { SwipeDirection } from '@practics/tryon-core';
import { depthToNormalMap } from '@practics/tryon-core';
import { foreshortenFactor, selectGarmentView } from '@practics/tryon-core';
import type { Accelerator, PipelineResult } from '@practics/tryon-core';

/** The advanced-mode normal map(s) for the currently-selected garment
 * (Phase A3) — mirrors LoadedGarmentImages' single/lehenga-choli shape,
 * since a lehenga-choli's two pieces each need their own normal map. A
 * single-piece garment's optional back photo (Phase A4) gets its own
 * normal map too, used when the live-mode back view is active (Phase A5). */
type GarmentNormals =
  | { kind: 'single'; normal: OffscreenCanvas; backNormal: OffscreenCanvas | null }
  | { kind: 'lehenga-choli'; choliNormal: OffscreenCanvas; lehengaNormal: OffscreenCanvas };

/** The loaded ImageBitmap(s) for the currently-selected garment — one for a
 * single-piece garment (plus its optional back photo), two for a
 * lehenga-choli (choli + lehenga skirt). */
type LoadedGarmentImages =
  | { kind: 'single'; image: ImageBitmap; backImage: ImageBitmap | null }
  | { kind: 'lehenga-choli'; choliImage: ImageBitmap; lehengaImage: ImageBitmap };

async function fetchBitmap(path: string): Promise<ImageBitmap> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return createImageBitmap(await res.blob());
}

function closeGarmentImages(images: LoadedGarmentImages | null): void {
  if (!images) return;
  if (images.kind === 'single') {
    images.image.close();
    images.backImage?.close();
  } else {
    images.choliImage.close();
    images.lehengaImage.close();
  }
}

type Mode = 'photo' | 'live';

/**
 * What the TOP outfit slot can hold. A lehenga-choli is a complete two-piece
 * outfit and occupies both slots at once — selecting it clears the bottom
 * slot, and selecting pants clears it (see selectGarment's slot rules).
 * Everything else top-like (tshirt/shirt/top/kurti/dress) coexists with
 * pants in the bottom slot — kurti-over-jeans being the classic combo.
 */
type TopSlotGarment = SinglePieceGarment | LehengaCholiGarment;

export default function App() {
  const [mode, setMode] = useState<Mode>('photo');
  const [accelerator, setAccelerator] = useState<Accelerator>('webgpu');
  const pipeline = usePipeline(accelerator);
  const catalog = useGarmentCatalog();
  const userGarments = useUserGarments();
  const webcam = useWebcam();
  const live = useLiveTryOn(pipeline, webcam.videoEl, mode === 'live');
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showMask, setShowMask] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [selectedTop, setSelectedTop] = useState<TopSlotGarment | null>(null);
  const [selectedBottom, setSelectedBottom] = useState<PantsGarment | null>(null);
  const [garmentImages, setGarmentImages] = useState<LoadedGarmentImages | null>(null);
  const [bottomImage, setBottomImage] = useState<ImageBitmap | null>(null);
  const [garmentError, setGarmentError] = useState<string | null>(null);
  const [tryOnStatus, setTryOnStatus] = useState<TryOnStatus | null>(null);
  const imageRef = useRef<ImageBitmap | null>(null);
  const resultRef = useRef<PipelineResult | null>(null);
  const garmentImagesRef = useRef<LoadedGarmentImages | null>(null);
  const bottomImageRef = useRef<ImageBitmap | null>(null);

  /**
   * Applies the slot rules for picking a garment: pants fill the bottom
   * slot, anything top-like fills the top slot, a lehenga-choli is
   * exclusive (fills top, clears bottom — and pants selection clears IT).
   * `toggle` (default true, the picker's behavior) makes tapping the
   * already-worn garment remove it from its slot; gesture cycling passes
   * false so wrapping around the list onto a worn garment keeps it worn.
   */
  const selectGarment = useCallback((g: Garment | null, opts?: { toggle?: boolean }) => {
    const toggle = opts?.toggle ?? true;
    if (!g) {
      setSelectedTop(null);
      setSelectedBottom(null);
      return;
    }
    if (g.category === 'pants') {
      setSelectedBottom((prev) => (toggle && prev?.id === g.id ? null : g));
      setSelectedTop((prev) => (prev?.category === 'lehenga-choli' ? null : prev));
    } else if (g.category === 'lehenga-choli') {
      setSelectedTop((prev) => (toggle && prev?.id === g.id ? null : g));
      setSelectedBottom(null);
    } else {
      setSelectedTop((prev) => (toggle && prev?.id === g.id ? null : g));
    }
  }, []);

  // Advanced mode (Phase A1, see docs/plan-3d-garment-assets.md): the depth
  // worker + its ~50MB model only exist once the user opts in via the
  // "Enhance (3D)" button below.
  const advanced = useAdvancedMode();
  const [showDepth, setShowDepth] = useState(false);
  const [showShading, setShowShading] = useState(true);
  const [photoDepth, setPhotoDepth] = useState<ImageBitmap | null>(null);
  const [garmentDepth, setGarmentDepth] = useState<ImageBitmap | null>(null);
  const [garmentNormals, setGarmentNormals] = useState<GarmentNormals | null>(null);
  const photoDepthRef = useRef<ImageBitmap | null>(null);
  const garmentDepthRef = useRef<ImageBitmap | null>(null);

  // Photo-mode person matting (see docs/production-gaps.md): a MODNet matte
  // replaces the low-res segmenter mask for crisp clip edges in stills —
  // most visible around hair. Rides the advanced-mode opt-in so its worker
  // (and one-time model download) only exists once "Enhance (3D)" is on.
  // Deliberately a separate useMatting instance from GarmentUpload's: that
  // one's lifecycle is tied to the upload dialog being open, and tearing it
  // down on dialog close must not kill photo matting (the browser cache
  // dedupes the model download between them).
  const photoMatting = useMatting();
  const advancedReady = advanced.status === 'ready';
  const setPhotoMattingEnabled = photoMatting.setEnabled;
  useEffect(() => {
    setPhotoMattingEnabled(advancedReady);
  }, [advancedReady, setPhotoMattingEnabled]);

  const [personMatte, setPersonMatte] = useState<ImageBitmap | null>(null);
  const personMatteRef = useRef<ImageBitmap | null>(null);
  useEffect(() => {
    if (mode !== 'photo' || !image || photoMatting.status !== 'ready') {
      personMatteRef.current?.close();
      personMatteRef.current = null;
      setPersonMatte(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Downscale before matting (config.photoMatting.maxDim): MODNet's
        // useful edge detail tops out well below photo resolution, and the
        // matte gets upscaled + feathered at composite time regardless.
        const scale = Math.min(1, config.photoMatting.maxDim / Math.max(image.width, image.height));
        const copy = await createImageBitmap(image, {
          resizeWidth: Math.max(1, Math.round(image.width * scale)),
          resizeHeight: Math.max(1, Math.round(image.height * scale)),
        });
        const matte = await photoMatting.mattePerson(copy);
        if (cancelled) {
          matte.close();
          return;
        }
        personMatteRef.current?.close();
        personMatteRef.current = matte;
        setPersonMatte(matte);
      } catch {
        // Best-effort refinement — the segmenter mask still composites fine.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, image, photoMatting.status, photoMatting.mattePerson]);

  // Live-mode orientation (Phase A5, see docs/plan-3d-garment-assets.md
  // §5.4.3) and throttled depth (§5.5) — both meaningful only while
  // actually live; each hook no-ops (null) outside of live mode.
  const liveOrientation = useTorsoOrientation(
    live.latest?.result.keypoints ?? null,
    mode === 'live',
    config.orientation,
  );
  const liveDepth = useLiveDepth(advanced, live.latest?.frame ?? null, mode === 'live');

  // Fullscreen live view: a button-triggered overlay (cam feed + garment
  // strip + close), only meaningful in live mode. `isFullscreen` is the
  // source of truth for our own overlay visibility; it's kept in sync with
  // the REAL browser fullscreen state (so ESC / the browser's own UI also
  // exits correctly) via the fullscreenchange listener below, but doesn't
  // strictly require requestFullscreen to have succeeded — if the
  // Fullscreen API is unavailable or denied, the overlay still covers the
  // viewport via fixed positioning, just without hiding browser chrome.
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setIsFullscreen(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (mode !== 'live' && isFullscreen) {
      if (document.fullscreenElement) void document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, [mode, isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape already exits real browser fullscreen on its own; this only
      // does the extra work of also closing our overlay in the CSS-only
      // fallback path, where there's no native fullscreen to exit.
      if (e.key === 'Escape' && !document.fullscreenElement) setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  const enterFullscreen = () => {
    setIsFullscreen(true);
    fullscreenRef.current?.requestFullscreen?.().catch(() => {
      // Fallback: the CSS-only overlay above still works without native fullscreen.
    });
  };

  const exitFullscreenMode = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setIsFullscreen(false);
  };

  // Gesture hint: shown for a few seconds after entering fullscreen live
  // view, then fades — enough for a first-time user to read it once
  // without cluttering the screen for repeat visits.
  const [showGestureHint, setShowGestureHint] = useState(false);
  useEffect(() => {
    if (!isFullscreen) return;
    setShowGestureHint(true);
    const t = setTimeout(() => setShowGestureHint(false), 6000);
    return () => clearTimeout(t);
  }, [isFullscreen]);

  // On-demand gesture help (the "?" button) — a persistent way to re-read
  // the same instructions the auto-fading hint above only shows once per
  // session. Reset on every fullscreen exit so it never silently reopens
  // pinned on the next entry.
  const [showGestureHelp, setShowGestureHelp] = useState(false);
  useEffect(() => {
    if (!isFullscreen) setShowGestureHelp(false);
  }, [isFullscreen]);

  // Photo capture (gesture: swipe up, or the on-screen button): a 5s
  // countdown, then a snapshot of the composited fullscreen canvas, then a
  // review screen (retake / download / share). The captured Blob's object
  // URL is revoked wherever the review state is left (retake or a fresh
  // capture), never left to leak.
  type CaptureState =
    | { kind: 'idle' }
    | { kind: 'countdown'; secondsLeft: number }
    | { kind: 'review'; photoUrl: string; blob: Blob };
  const [captureState, setCaptureState] = useState<CaptureState>({ kind: 'idle' });
  const fullscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shareUnsupported, setShareUnsupported] = useState(false);

  const startCountdown = useCallback(() => {
    setCaptureState((s) => (s.kind === 'idle' ? { kind: 'countdown', secondsLeft: 5 } : s));
  }, []);

  const discardPhoto = useCallback(() => {
    setCaptureState((s) => {
      if (s.kind === 'review') URL.revokeObjectURL(s.photoUrl);
      return { kind: 'idle' };
    });
    setShareUnsupported(false);
  }, []);

  const sharePhoto = useCallback(async () => {
    if (captureState.kind !== 'review') return;
    const file = new File([captureState.blob], 'try-on.png', { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My virtual try-on', text: 'Check out this outfit!' });
      } catch {
        // User cancelled the share sheet, or it failed silently — stay on the review screen either way.
      }
    } else {
      setShareUnsupported(true);
    }
  }, [captureState]);

  useEffect(() => {
    if (captureState.kind !== 'countdown') return;
    if (captureState.secondsLeft <= 0) {
      const canvas = fullscreenCanvasRef.current;
      if (!canvas) {
        setCaptureState({ kind: 'idle' });
        return;
      }
      canvas.toBlob((blob) => {
        if (blob) setCaptureState({ kind: 'review', photoUrl: URL.createObjectURL(blob), blob });
        else setCaptureState({ kind: 'idle' });
      }, 'image/png');
      return;
    }
    const t = setTimeout(() => {
      setCaptureState((s) => (s.kind === 'countdown' ? { kind: 'countdown', secondsLeft: s.secondsLeft - 1 } : s));
    }, 1000);
    return () => clearTimeout(t);
  }, [captureState]);

  // Revoke the object URL on unmount if a review photo is still pending —
  // discardPhoto/a fresh capture handle the normal paths, this only covers
  // the app closing/navigating away mid-review. Reads a ref rather than
  // setting state during teardown.
  const captureStateRef = useRef(captureState);
  captureStateRef.current = captureState;
  useEffect(() => {
    return () => {
      const s = captureStateRef.current;
      if (s.kind === 'review') URL.revokeObjectURL(s.photoUrl);
    };
  }, []);

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

  // Load the TOP slot's PNG(s) into ImageBitmap(s) for the compositor
  // — one image for a single-piece garment, two (choli + lehenga) for a
  // lehenga-choli ensemble. The bottom slot loads independently below.
  useEffect(() => {
    if (!selectedTop) {
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
          selectedTop.category === 'lehenga-choli'
            ? {
                kind: 'lehenga-choli',
                choliImage: await fetchBitmap(selectedTop.choli.image),
                lehengaImage: await fetchBitmap(selectedTop.lehenga.image),
              }
            : {
                kind: 'single',
                image: await fetchBitmap(selectedTop.image),
                backImage: selectedTop.back ? await fetchBitmap(selectedTop.back.image) : null,
              };
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
  }, [selectedTop]);

  // Bottom (pants) slot image — a single bitmap with the same
  // load/replace/close lifecycle as the top slot's.
  useEffect(() => {
    if (!selectedBottom) {
      bottomImageRef.current?.close();
      bottomImageRef.current = null;
      setBottomImage(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchBitmap(selectedBottom.image);
        if (cancelled) {
          next.close();
          return;
        }
        bottomImageRef.current?.close();
        bottomImageRef.current = next;
        setBottomImage(next);
      } catch (err) {
        if (!cancelled) setGarmentError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedBottom]);

  // Photo-mode person depth (Phase A1 debug view + Phase A2 depth-tested
  // occlusion; live-mode throttling is Phase A5). Computed whenever it's
  // actually useful — the "depth" debug toggle is on, or a garment is
  // selected (occlusion quality improves silently even if the debug view
  // itself is off) — and recomputed whenever the displayed photo changes.
  useEffect(() => {
    if (
      mode !== 'photo' ||
      advanced.status !== 'ready' ||
      !image ||
      !(showDepth || selectedTop || selectedBottom)
    ) {
      photoDepthRef.current?.close();
      photoDepthRef.current = null;
      setPhotoDepth(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // estimateDepth transfers (consumes) its input; keep our own copy for rendering.
        const copy = await createImageBitmap(image);
        const depth = await advanced.estimateDepth(copy);
        if (cancelled) {
          depth.close();
          return;
        }
        photoDepthRef.current?.close();
        photoDepthRef.current = depth;
        setPhotoDepth(depth);
      } catch {
        // Depth is a debug-overlay feature; a failure here shouldn't block the app.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDepth, mode, advanced.status, image, selectedTop, selectedBottom]);

  // Garment depth preview (Phase A1 "done when": depth maps render for
  // garment images too) + normal maps for relighting (Phase A3). A
  // lehenga-choli's two pieces are separate photos and each needs its own
  // normal map; the thumbnail preview still shows just the primary
  // (choli) depth. Normal-map generation is pure synchronous math on the
  // depth we already computed (pipeline/normalMap.ts) — no extra model
  // inference beyond the depth estimation itself.
  useEffect(() => {
    if (advanced.status !== 'ready' || !garmentImages) {
      garmentDepthRef.current?.close();
      garmentDepthRef.current = null;
      setGarmentDepth(null);
      setGarmentNormals(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (garmentImages.kind === 'lehenga-choli') {
          const choliCopy = await createImageBitmap(garmentImages.choliImage);
          const choliDepth = await advanced.estimateDepth(choliCopy);
          if (cancelled) {
            choliDepth.close();
            return;
          }
          const choliNormal = depthToNormalMap(
            choliDepth,
            garmentImages.choliImage,
            config.relighting.normalStrength,
          );

          const lehengaCopy = await createImageBitmap(garmentImages.lehengaImage);
          const lehengaDepth = await advanced.estimateDepth(lehengaCopy);
          if (cancelled) {
            choliDepth.close();
            lehengaDepth.close();
            return;
          }
          const lehengaNormal = depthToNormalMap(
            lehengaDepth,
            garmentImages.lehengaImage,
            config.relighting.normalStrength,
          );
          lehengaDepth.close(); // only needed to derive its normal map above.

          garmentDepthRef.current?.close();
          garmentDepthRef.current = choliDepth;
          setGarmentDepth(choliDepth);
          setGarmentNormals({ kind: 'lehenga-choli', choliNormal, lehengaNormal });
        } else {
          const copy = await createImageBitmap(garmentImages.image);
          const depth = await advanced.estimateDepth(copy);
          if (cancelled) {
            depth.close();
            return;
          }
          const normal = depthToNormalMap(depth, garmentImages.image, config.relighting.normalStrength);

          let backNormal: OffscreenCanvas | null = null;
          if (garmentImages.backImage) {
            const backCopy = await createImageBitmap(garmentImages.backImage);
            const backDepth = await advanced.estimateDepth(backCopy);
            if (cancelled) {
              depth.close();
              backDepth.close();
              return;
            }
            backNormal = depthToNormalMap(backDepth, garmentImages.backImage, config.relighting.normalStrength);
            backDepth.close(); // only needed to derive its normal map above.
          }

          garmentDepthRef.current?.close();
          garmentDepthRef.current = depth;
          setGarmentDepth(depth);
          setGarmentNormals({ kind: 'single', normal, backNormal });
        }
      } catch {
        // Best-effort preview/shading; ignore failures — flat rendering still works.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advanced.status, garmentImages]);

  // Bottom-slot normal map (Phase A3 shading for the pants piece) — same
  // depth→normal derivation as the top slot's, no preview thumbnail.
  const [bottomNormal, setBottomNormal] = useState<OffscreenCanvas | null>(null);
  useEffect(() => {
    if (advanced.status !== 'ready' || !bottomImage) {
      setBottomNormal(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const copy = await createImageBitmap(bottomImage);
        const depth = await advanced.estimateDepth(copy);
        if (cancelled) {
          depth.close();
          return;
        }
        setBottomNormal(depthToNormalMap(depth, bottomImage, config.relighting.normalStrength));
        depth.close(); // only needed to derive the normal map above.
      } catch {
        // Best-effort shading; flat rendering still works.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advanced.status, bottomImage]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadBitmap(file);
    e.target.value = '';
  };

  const onTestPhoto = async (name: string) => {
    setRunError(null);
    const res = await fetch(assetUrl(`/test-photos/${name}`));
    if (!res.ok) {
      setRunError(`could not load ${name} — missing from public/test-photos/ (try \`npm run fetch-test-photos -- --force\`)`);
      return;
    }
    void loadBitmap(await res.blob());
  };

  // Live-mode front/back/fade decision (Phase A5) — a lehenga-choli never
  // has a back piece (schema.ts), so it always resolves hasBack=false and
  // just gets the profile-band fade, never a view swap.
  const viewSelection = useMemo(() => {
    if (!selectedTop && !selectedBottom) return null;
    const hasBack = !!selectedTop && selectedTop.category !== 'lehenga-choli' && !!selectedTop.back;
    return selectGarmentView(liveOrientation, hasBack, config.orientation);
  }, [selectedTop, selectedBottom, liveOrientation]);

  const garmentOverlay = useMemo((): GarmentOverlay | null => {
    if (!viewSelection) return null;
    // Shading is an advanced-mode enhancement (Phase A3): the "shading"
    // checkbox is the A/B toggle demonstrating flat-vs-shaded, so simply
    // omit the normal map(s) when it's off rather than threading a
    // separate flag through the compositor.
    const normals = showShading ? garmentNormals : null;
    const factor = liveOrientation
      ? foreshortenFactor(
          liveOrientation.yawDeg,
          config.orientation.foreshortenFloor,
          config.orientation.foreshortenDeadbandDeg,
        )
      : 1;

    if (selectedTop?.category === 'lehenga-choli') {
      // Transient mismatch guard: the slot changed shape and the async image
      // load hasn't landed yet — skip a render rather than pass mismatched
      // data (each piece below guards the same way).
      if (garmentImages?.kind !== 'lehenga-choli') return null;
      return {
        kind: 'lehenga-choli',
        choliImage: garmentImages.choliImage,
        choliAnchors: selectedTop.choli.anchors,
        lehengaImage: garmentImages.lehengaImage,
        lehengaAnchors: selectedTop.lehenga.anchors,
        skirtLength: selectedTop.meta.length,
        choliNormal: normals?.kind === 'lehenga-choli' ? normals.choliNormal : null,
        lehengaNormal: normals?.kind === 'lehenga-choli' ? normals.lehengaNormal : null,
        foreshortenFactor: factor,
        viewAlpha: viewSelection.alpha,
      };
    }

    let top: Extract<GarmentOverlay, { kind: 'outfit' }>['top'] = null;
    if (selectedTop && garmentImages?.kind === 'single') {
      // The back photo's own L/R anchors follow the same image-left/right
      // convention as the front (pipeline/autoAnchor.ts) — mirror them when
      // warping onto the body, since the shoulder that anchors the front's
      // left side anchors the back's right side once viewed from behind
      // (see anchorMapping.mirrorAnchorsLR).
      const useBack = viewSelection.useBack && garmentImages.backImage && selectedTop.back;
      top = {
        image: useBack ? garmentImages.backImage! : garmentImages.image,
        anchors: useBack ? mirrorAnchorsLR(selectedTop.back!.anchors) : selectedTop.anchors,
        hemLength: selectedTop.meta.length,
        sleeves: selectedTop.meta.sleeves,
        normal: useBack
          ? (normals?.kind === 'single' ? normals.backNormal : null)
          : (normals?.kind === 'single' ? normals.normal : null),
      };
    }
    const pants: Extract<GarmentOverlay, { kind: 'outfit' }>['pants'] =
      selectedBottom && bottomImage
        ? {
            image: bottomImage,
            anchors: selectedBottom.anchors,
            hemLength: selectedBottom.meta.length,
            normal: showShading ? bottomNormal : null,
          }
        : null;

    if (!top && !pants) return null;
    return { kind: 'outfit', top, pants, foreshortenFactor: factor, viewAlpha: viewSelection.alpha };
  }, [
    selectedTop,
    selectedBottom,
    garmentImages,
    bottomImage,
    garmentNormals,
    bottomNormal,
    showShading,
    viewSelection,
    liveOrientation,
  ]);

  const displayImage = mode === 'live' ? (live.latest?.frame ?? null) : image;
  // Photo results get their mask upgraded to the MODNet person matte once
  // it lands (progressive: the segmenter mask composites immediately, edges
  // sharpen a beat later). The matte was computed from a downscale of this
  // same photo, so it can substitute directly — every mask consumer scales
  // to frame size anyway.
  const photoResult = useMemo((): PipelineResult | null => {
    if (!result || !personMatte) return result;
    return { ...result, maskBitmap: personMatte };
  }, [result, personMatte]);
  const displayResult = mode === 'live' ? (live.latest?.result ?? null) : photoResult;

  /** Both worn slots' ids, for the picker's multi-highlight. */
  const selectedIds = useMemo(
    () => [selectedTop?.id, selectedBottom?.id].filter((id): id is string => !!id),
    [selectedTop, selectedBottom],
  );

  // User-uploaded garments first (most-recently-added on top, so a new
  // upload doesn't require scrolling to find), catalog garments below.
  const allGarments = useMemo(
    (): Garment[] =>
      catalog.status === 'ready'
        ? [...([...userGarments.garments].reverse() as Garment[]), ...catalog.garments]
        : [],
    [catalog.status, catalog.garments, userGarments.garments],
  );

  /**
   * What gesture swipes cycle through: top-slot garments only. Including
   * pants in the cycle made swipes LOOK dead across the catalog's pants
   * stretch (field-reported as "gestures did not work for dress change"):
   * landing on pants swaps the bottom slot, which is invisible under a
   * knee/ankle dress — the flash fires but nothing on screen changes,
   * three swipes in a row. Bottoms are picked by tapping the fullscreen
   * picker instead; the swipe gesture means "change my look's main piece".
   */
  const cycleGarments = useMemo(
    () => allGarments.filter((g): g is TopSlotGarment => g.category !== 'pants'),
    [allGarments],
  );

  // A fresh live session starts wearing something rather than "none" — an
  // empty first impression in the fullscreen kiosk view. Only fires once
  // nothing is selected yet; doesn't override a choice already made in
  // photo mode carrying over into live.
  useEffect(() => {
    if (mode === 'live' && !selectedTop && !selectedBottom && allGarments.length > 0) {
      // Prefer a top-like garment for the first impression — it's also
      // where the swipe cycle lives, so the first swipe visibly works.
      selectGarment(cycleGarments[0] ?? allGarments[0], { toggle: false });
    }
  }, [mode, selectedTop, selectedBottom, allGarments, cycleGarments, selectGarment]);

  // Hands-free garment cycling (see pipeline/gesture.ts + hooks/useGestureSwipe.ts):
  // a left/right swipe steps through the same list the sidebar/fullscreen
  // picker shows, wrapping around either end. Starting from "none" (no
  // garment) picks the first/last one rather than requiring an extra swipe
  // to leave "none". An upward swipe starts the photo-capture countdown
  // instead of touching the garment selection; downward is unused for now.
  // Brief on-screen acknowledgment of a fired swipe (field feedback:
  // detection misses are silent, so without this a *successful* swipe whose
  // garment loads a beat later is indistinguishable from a miss — users
  // kept re-swiping). Keyed so a rapid second swipe restarts the animation.
  const [swipeFlash, setSwipeFlash] = useState<{ direction: 'left' | 'right'; key: number } | null>(null);
  const swipeFlashTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(swipeFlashTimeoutRef.current), []);

  const onGesture = useCallback(
    (direction: SwipeDirection) => {
      if (direction === 'up') {
        startCountdown();
        return;
      }
      if (direction === 'down') return;
      if (cycleGarments.length === 0) return;
      setSwipeFlash((prev) => ({ direction, key: (prev?.key ?? 0) + 1 }));
      clearTimeout(swipeFlashTimeoutRef.current);
      swipeFlashTimeoutRef.current = setTimeout(() => setSwipeFlash(null), 700);
      // The cycle only ever changes the top slot, so the worn top IS the
      // cursor — no separate "last picked" tracking needed.
      const currentIndex = selectedTop ? cycleGarments.findIndex((g) => g.id === selectedTop.id) : -1;
      const delta = direction === 'right' ? 1 : -1;
      const nextIndex = (currentIndex + delta + cycleGarments.length) % cycleGarments.length;
      // toggle: false — wrapping the cycle onto the garment already worn
      // should keep wearing it, not strip it off.
      selectGarment(cycleGarments[nextIndex], { toggle: false });
    },
    [cycleGarments, selectedTop, selectGarment, startCountdown],
  );

  // Delete a user-uploaded garment. GarmentPicker only ever calls this for
  // ids with the user-upload prefix (see USER_GARMENT_ID_PREFIX), and only
  // after its own tap-to-arm / tap-again-to-confirm sequence — a blocking
  // window.confirm() here would freeze the JS thread (and the live
  // inference loop) for however long the dialog is up, which is a bad idea
  // sitting on top of a live camera view.
  const deleteGarment = useCallback(
    (id: string) => {
      if (selectedTop?.id === id) setSelectedTop(null);
      if (selectedBottom?.id === id) setSelectedBottom(null);
      void userGarments.removeGarment(id);
    },
    [selectedTop, selectedBottom, userGarments],
  );

  useGestureSwipe(
    live.latest?.result.keypoints ?? null,
    live.latest?.frame.width ?? null,
    mode === 'live',
    onGesture,
  );

  return (
    <div className="app">
      <div className="top-bar">
        <header>
          {mode !== 'live' && (
            <>
              <h1>Virtual Try-On</h1>
              <p className="tagline">
                Runs entirely in your browser — no server, no uploads. Your photo and webcam video never
                leave this device.{' '}
                <a href={assetUrl('/about.html')} target="_blank" rel="noopener noreferrer">
                  How it works →
                </a>
              </p>
            </>
          )}
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
      </div>

      <div className="layout">
        <div className="main-column">
          <div className="controls">
            <div className="segmented" role="group" aria-label="mode">
              <button className={mode === 'photo' ? 'selected' : ''} onClick={() => setMode('photo')}>
                photo
              </button>
              <button
                className={mode === 'live' ? 'selected' : ''}
                onClick={() => {
                  setMode('live');
                  enterFullscreen();
                }}
              >
                live webcam
              </button>
            </div>
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
            {advanced.status === 'off' && (
              <button onClick={() => advanced.setEnabled(true)}>
                Enhance (3D) · ~30MB one-time download{!advanced.webgpuSupported ? ' · CPU (slower)' : ''}
              </button>
            )}
            {advanced.status === 'downloading' && (
              <span className="hint">
                downloading depth model…{' '}
                {advanced.progress !== null ? `${Math.round(advanced.progress * 100)}%` : ''}
              </span>
            )}
            {advanced.status === 'error' && (
              <>
                <span className="error">advanced mode failed: {advanced.error}</span>
                <button onClick={() => advanced.setEnabled(false)}>dismiss</button>
              </>
            )}
            {advanced.status === 'ready' && (
              <>
                <span className="hint">advanced mode ready ({advanced.device})</span>
                <label>
                  <input
                    type="checkbox"
                    checked={showDepth}
                    disabled={mode !== 'photo'}
                    onChange={(e) => setShowDepth(e.target.checked)}
                  />
                  depth
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showShading}
                    onChange={(e) => setShowShading(e.target.checked)}
                  />
                  shading
                </label>
                <button onClick={() => advanced.setEnabled(false)}>turn off</button>
                {mode === 'live' && liveOrientation && (
                  <span className="hint">
                    yaw ~{Math.round(liveOrientation.yawDeg)}° ({liveOrientation.zone})
                  </span>
                )}
              </>
            )}
          </div>

          {mode === 'photo' && (
            <div className="controls">
              <label>
              Your Photo 
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
              {!isFullscreen && <button onClick={enterFullscreen}>⛶ fullscreen</button>}
              <span className="hint">
                {webcam.status === 'requesting' && 'requesting camera access…'}
                {webcam.status === 'ready' &&
                  pipeline.status === 'ready' &&
                  !live.latest &&
                  'starting live inference…'}
                {webcam.status === 'error' && <span className="error">camera error: {webcam.error}</span>}
              </span>
            </div>
          )}

          {userGarments.status === 'error' && (
            <p className="error">user garment library error: {userGarments.error}</p>
          )}
          {runError && <p className="error">{runError}</p>}
          {live.error && <p className="error">live inference error: {live.error}</p>}
          {garmentError && <p className="error">garment load failed: {garmentError}</p>}
          {processing && <p className="hint">running inference…</p>}
          {tryOnStatus === 'pose-not-anchorable' && (
            <p className="hint">
              torso not confidently detected — garment can't be anchored on this photo/pose.
            </p>
          )}
          {viewSelection?.hint === 'turn-to-front' && (
            <p className="hint">turn back toward the camera to see this garment.</p>
          )}
          {viewSelection?.hint === 'turn-to-back' && (
            <p className="hint">keep turning — the back view will appear.</p>
          )}

          {/* Skipped while the fullscreen overlay owns the view below — it's
              fully covered anyway, and rendering both would composite every
              live frame twice for nothing. */}
          {!isFullscreen && (
            <main>
              {displayImage ? (
                <DebugCanvas
                  image={displayImage}
                  result={displayResult}
                  showMask={showMask}
                  showSkeleton={showSkeleton}
                  garment={garmentOverlay}
                  depthBitmap={mode === 'photo' && showDepth ? photoDepth : null}
                  personDepthBitmap={mode === 'photo' ? photoDepth : liveDepth.depth}
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
          )}
        </div>

        <aside className="garment-sidebar">
          <GarmentUpload
            onGarmentAdded={async (stored) => {
              const garment = await userGarments.addGarment(stored);
              selectGarment(garment, { toggle: false });
            }}
          />

          <div className="garment-sidebar-list">
            <span className="hint">garment:</span>
            {catalog.status === 'loading' && <span className="hint">loading catalog…</span>}
            {catalog.status === 'error' && <span className="error">catalog error: {catalog.error}</span>}
            {catalog.status === 'ready' && (
              <GarmentPicker
                garments={allGarments}
                selectedIds={selectedIds}
                onSelect={selectGarment}
                onDelete={deleteGarment}
              />
            )}
            {garmentDepth && (
              <span className="garment-depth-preview" title="garment depth map">
                <BitmapCanvas bitmap={garmentDepth} />
              </span>
            )}
          </div>
        </aside>
      </div>

      {/* Always mounted (never conditionally removed) so requestFullscreen
          has a real DOM node to target the moment the button is clicked;
          `.active` is what actually makes it visible — see index.css. This
          also keeps working if the Fullscreen API itself is unavailable or
          denied, since the fixed positioning alone covers the viewport. */}
      <div ref={fullscreenRef} className={`fullscreen-view${isFullscreen ? ' active' : ''}`}>
        {isFullscreen && (
          <>
            <div className="fullscreen-canvas-wrap">
              {displayImage ? (
                <DebugCanvas
                  ref={fullscreenCanvasRef}
                  image={displayImage}
                  result={displayResult}
                  showMask={showMask}
                  showSkeleton={showSkeleton}
                  garment={garmentOverlay}
                  depthBitmap={null}
                  personDepthBitmap={liveDepth.depth}
                  onTryOnStatus={setTryOnStatus}
                />
              ) : (
                <p className="hint">Waiting for camera…</p>
              )}
            </div>

            {viewSelection?.hint === 'turn-to-front' && (
              <p className="hint fullscreen-hint">turn back toward the camera to see this garment.</p>
            )}
            {viewSelection?.hint === 'turn-to-back' && (
              <p className="hint fullscreen-hint">keep turning — the back view will appear.</p>
            )}

            {showGestureHint && captureState.kind === 'idle' && (
              <div className="fullscreen-gesture-hint">
                ‹ swipe to change outfit › &nbsp;·&nbsp; ↑ swipe up for a photo
              </div>
            )}

            {swipeFlash && captureState.kind === 'idle' && (
              <div key={swipeFlash.key} className={`swipe-flash swipe-flash-${swipeFlash.direction}`} aria-hidden>
                {swipeFlash.direction === 'right' ? '›' : '‹'}
              </div>
            )}

            {captureState.kind === 'idle' && (
              <div className="fullscreen-help">
                <button
                  className="fullscreen-help-button"
                  onClick={() => setShowGestureHelp((v) => !v)}
                  aria-expanded={showGestureHelp}
                  aria-label="gesture help"
                >
                  ?
                </button>
                {showGestureHelp && (
                  <div className="fullscreen-help-panel">
                    <p>
                      <strong>‹ swipe left/right ›</strong>
                      <br />
                      change the outfit
                    </p>
                    <p>
                      <strong>↑ swipe up</strong>
                      <br />
                      take a photo
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="fullscreen-overlay-top">
              <button onClick={startCountdown} disabled={captureState.kind !== 'idle'}>
                📷 take photo
              </button>
              <button onClick={exitFullscreenMode}>
                ✕ close
              </button>
            </div>

            <div className="fullscreen-garments">
              {catalog.status === 'ready' && (
                <GarmentPicker
                  garments={allGarments}
                  selectedIds={selectedIds}
                  onSelect={selectGarment}
                  onDelete={deleteGarment}
                />
              )}
            </div>

            {captureState.kind === 'countdown' && (
              <div className="capture-overlay capture-countdown">
                <div className="capture-countdown-number">{captureState.secondsLeft}</div>
                <button onClick={() => setCaptureState({ kind: 'idle' })}>cancel</button>
              </div>
            )}

            {captureState.kind === 'review' && (
              <div className="capture-overlay capture-review">
                <img src={captureState.photoUrl} alt="captured try-on photo" className="capture-review-image" />
                {shareUnsupported && (
                  <p className="hint">
                    sharing isn't supported in this browser — use download, then share it yourself.
                  </p>
                )}
                <div className="capture-review-actions">
                  <button onClick={discardPhoto}>↺ retake</button>
                  <a href={captureState.photoUrl} download="try-on.png">
                    ⭳ download
                  </a>
                  <button onClick={() => void sharePhoto()}>share</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
