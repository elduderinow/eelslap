"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import { Canvas, extend } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Leva, folder, useControls } from "leva";
import SlapScene from "./SlapScene";
import { SWING } from "./slapTimeline";
import Ssgi from "./Ssgi";
import Stage from "./Stage";

// Register the WebGPU build's classes with the r3f reconciler so JSX elements
// such as <meshPhysicalNodeMaterial /> resolve to the node-material versions.
extend(THREE as unknown as Parameters<typeof extend>[0]);

const TARGET: [number, number, number] = [0, 0, 0];

function Lights() {
  const { lamp, rim, ambient } = useControls({
    light: folder(
      {
        lamp: { value: 5, min: 0, max: 12, step: 0.05 },
        rim: { value: 3, min: 0, max: 8, step: 0.05 },
        ambient: { value: 1, min: 0, max: 4, step: 0.05 },
      },
      { collapsed: true },
    ),
  });

  // The normalmap example's rig. The lamp sitting just off the lens is what
  // makes the normal map read: a light near the eye direction rakes across
  // every pore, where a light off to one side just shades the whole cheek.
  // Its intensity is scaled from the example's 30-at-6-units by inverse square,
  // because our head is one unit tall rather than four.
  return (
    <>
      <ambientLight color="#ffffff" intensity={ambient} />
      <pointLight position={[0, 0, 1.8]} intensity={lamp} color="#ffffff" />
      <directionalLight
        position={[1, -0.5, -1]}
        intensity={rim}
        color="#ffffff"
      />
    </>
  );
}

export default function Viewport() {
  const { autoPlay, orbit } = useControls({
    scene: folder(
      {
        autoPlay: { value: false, label: "auto play" },
        orbit: { value: false, label: "orbit camera" },
      },
      { collapsed: false },
    ),
  });

  // The scrub bar lives out here in the DOM, because it has to sit over the
  // canvas rather than in it. These two nodes are the whole channel between it
  // and the scene: `SlapScene` reads the slider every frame while the fish is
  // idle, and writes back to both while a swing is playing. Nothing about
  // dragging it goes through React, so a drag never re-renders the scene.
  const slider = useRef<HTMLInputElement>(null);
  const live = useRef<HTMLSpanElement>(null);

  // Touch devices have no hoverable pointer to drive the fish with, so they
  // keep the bar. `pointer: coarse` asks about the *primary* input rather than
  // the screen width, which is the right question: a small window on a laptop
  // should still be mouse-driven.
  const [touch, setTouch] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches,
  );

  // ...but read once at mount that answer goes stale, and in two ways that both
  // end with a phone showing no bar:
  //
  //  - Devtools device emulation toggled after the page loaded keeps whatever
  //    was true at load. You would have to reload to get the bar back, which is
  //    not obvious when the thing you are testing *is* the bar.
  //  - Hybrids — a touchscreen laptop, an iPad with a trackpad — report a fine
  //    pointer and then get touched anyway, with no way back to the bar at all.
  //
  // So it tracks the query live, and whichever input was actually used last
  // wins over what the device claims about itself. The setters return the
  // current value when nothing changes, so React bails out rather than
  // re-rendering the scene on every mouse move.
  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)");
    const onQuery = () => setTouch(coarse.matches);
    const onTouch = () => setTouch((was) => (was ? was : true));
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "mouse") setTouch((was) => (was ? false : was));
    };

    coarse.addEventListener("change", onQuery);
    window.addEventListener("touchstart", onTouch, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });

    return () => {
      coarse.removeEventListener("change", onQuery);
      window.removeEventListener("touchstart", onTouch);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  const [startCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 720px)").matches,
  );

  return (
    <>
      <Leva titleBar={{ title: "controls" }} collapsed={startCollapsed} />

      <div id="scene" className={touch ? undefined : "no-cursor"}>
        <Canvas
          // `flat` is NoToneMapping. r3f defaults to ACES Filmic, which crushes
          // the shadow side of the face and turns the scan's colour map into
          // blotches; the decals example renders with no tone mapping at all.
          flat
          // Head-on, the way the original is framed: no floor, no three-quarter
          // angle. Pulled back so the head reads as a head in a room rather
          // than a face pressed against the lens.
          camera={{ position: [0, 0.02, 3.4], fov: 32, near: 0.1, far: 40 }}
          gl={async (props) => {
            const renderer = new THREE.WebGPURenderer(
              props as ConstructorParameters<typeof THREE.WebGPURenderer>[0],
            );
            await renderer.init();
            return renderer;
          }}
          frameloop="always"
          onCreated={({ camera }) => camera.lookAt(...TARGET)}
        >
          <color attach="background" args={["#3d6b2b"]} />

          <Lights />
          <Ssgi />
          <Stage />

          <Suspense fallback={null}>
            <SlapScene
              autoPlay={autoPlay}
              touch={touch}
              slider={slider}
              live={live}
            />
          </Suspense>

          {orbit && (
            <OrbitControls
              target={TARGET}
              enableDamping
              dampingFactor={0.08}
              minDistance={0.6}
              maxDistance={9}
            />
          )}
        </Canvas>
      </div>

      <div className={touch ? "hud" : "hud hud--low"}>
        <strong>Eel Slap</strong>
        {touch ? (
          <>
            drag the bar to swing, or hit <em>slap</em> in the panel
          </>
        ) : (
          <>
            move the mouse <em>left</em> and <em>right</em>
          </>
        )}
      </div>

      <div className={touch ? "scrub" : "scrub scrub--hidden"}>
        <span className="scrub-end">{SWING.restLeft}&deg;</span>
        {/* Mirrored in CSS so the left rest angle reads on the left of the bar
            and the right one on the right. The bounds are re-stated by
            `SlapScene` from the live panel values, so these are only what the
            first paint starts from. */}
        <input
          ref={slider}
          type="range"
          min={Math.min(SWING.restRight, SWING.restLeft)}
          max={Math.max(SWING.restRight, SWING.restLeft)}
          step={0.1}
          defaultValue={SWING.restRight}
          aria-label="eel yaw about the tail, in degrees"
          aria-hidden={touch ? undefined : true}
          tabIndex={touch ? undefined : -1}
        />
        <span className="scrub-end">{SWING.restRight}&deg;</span>
        <span className="scrub-live" ref={live}>
          {SWING.restRight.toFixed(1)}&deg;
        </span>
      </div>
    </>
  );
}
