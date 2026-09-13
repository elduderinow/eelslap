"use client";

import { useCallback, useEffect, useRef } from "react";

const FOLLOW = 16;

/**
 * Pointer position across the viewport, as 0..1. The pointer is the transport:
 * drag right and the eel swings, drag left and the slap runs backwards.
 *
 * Returns a sampler rather than state — the value changes every frame and
 * nothing in the scene is React-rendered from it.
 */
export function useScrub(autoPlay: boolean) {
  const target = useRef(0);
  const current = useRef(0);
  const touched = useRef(false);

  useEffect(() => {
    const set = (clientX: number) => {
      touched.current = true;
      target.current = Math.min(Math.max(clientX / window.innerWidth, 0), 1);
    };

    const onPointer = (event: PointerEvent) => set(event.clientX);
    const onTouch = (event: TouchEvent) => {
      if (event.touches.length > 0) set(event.touches[0].clientX);
    };

    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });

    return () => {
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("touchmove", onTouch);
    };
  }, []);

  return useCallback(
    (elapsed: number, delta: number) => {
      // Auto play is a demo mode, and the first pointer move takes over for good.
      if (autoPlay && !touched.current) {
        current.current = (elapsed * 0.42) % 1;
        return current.current;
      }

      // Damped follow: a jumpy mouse should not teleport the fish through the
      // face between two frames.
      current.current +=
        (target.current - current.current) * Math.min(delta * FOLLOW, 1);

      return current.current;
    },
    [autoPlay],
  );
}
