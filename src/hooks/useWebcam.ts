import { useCallback, useEffect, useRef, useState } from 'react';

export type WebcamStatus = 'idle' | 'requesting' | 'ready' | 'error';

export interface UseWebcam {
  status: WebcamStatus;
  error: string | null;
  /** Off-DOM <video> element streaming the camera; frame source for capture. */
  videoEl: HTMLVideoElement | null;
  start: () => Promise<void>;
  stop: () => void;
}

/**
 * getUserMedia wrapper. The video element is created once and kept off-DOM
 * (not rendered) — callers capture frames from it via
 * createImageBitmap(videoEl)/canvas rather than displaying it directly; the
 * live try-on canvas is the visible surface (see hooks/useLiveTryOn.ts).
 */
export function useWebcam(): UseWebcam {
  const [status, setStatus] = useState<WebcamStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus('idle');
    setVideoEl(null);
  }, []);

  const start = useCallback(async () => {
    setStatus('requesting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;

      let video = videoRef.current;
      if (!video) {
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        videoRef.current = video;
      }
      video.srcObject = stream;
      await video.play();
      setVideoEl(video);
      setStatus('ready');
    } catch (err) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => stop, [stop]);

  return { status, error, videoEl, start, stop };
}
