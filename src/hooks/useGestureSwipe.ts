import { useEffect, useRef } from 'react';
import { config } from '../config';
import { INITIAL_SWIPE_STATE, updateSwipeDetection, type SwipeDirection, type SwipeState } from '../pipeline/gesture';
import type { Keypoint } from '../pipeline/types';

/**
 * Wires pipeline/gesture.ts into the live pose stream. Only meaningful in
 * live mode — a single photo has no continuous frame stream to swipe
 * against — so `active` gates the whole thing and resets tracking state on
 * every false→true transition, so a fresh live session never inherits a
 * stale gesture-in-progress from a previous one (same pattern as
 * useTorsoOrientation's wasActiveRef).
 *
 * Buffer state lives in a ref, not React state: it updates on every live
 * frame (~config.targetFps), and only the rare, intentional event of a
 * completed swipe should cause a render (via onSwipe, same as clicking a
 * garment thumbnail already does) — not every keypoint tick.
 */
export function useGestureSwipe(
  keypoints: readonly Keypoint[] | null,
  frameWidth: number | null,
  frameHeight: number | null,
  active: boolean,
  onSwipe: (direction: SwipeDirection) => void,
): void {
  const stateRef = useRef<SwipeState>(INITIAL_SWIPE_STATE);
  const wasActiveRef = useRef(false);
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;

  useEffect(() => {
    if (!active) {
      wasActiveRef.current = false;
      stateRef.current = INITIAL_SWIPE_STATE;
      return;
    }
    if (!wasActiveRef.current) {
      stateRef.current = INITIAL_SWIPE_STATE;
      wasActiveRef.current = true;
    }
    if (!keypoints || !frameWidth || !frameHeight) return;
    const { state, swipe } = updateSwipeDetection(
      stateRef.current,
      keypoints,
      frameWidth,
      frameHeight,
      performance.now(),
      config.gesture,
    );
    stateRef.current = state;
    if (swipe) onSwipeRef.current(swipe);
  }, [keypoints, frameWidth, frameHeight, active]);
}
