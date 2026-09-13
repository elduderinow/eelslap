"use client";

import { Suspense, useState } from "react";
import * as THREE from "three/webgpu";
import { Canvas, extend } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Leva, folder, useControls } from "leva";
import SlapScene from "./SlapScene";
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

  const [startCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 720px)").matches,
  );

  return (
    <>
      <Leva titleBar={{ title: "controls" }} collapsed={startCollapsed} />

      <div id="scene">
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
          onCreated={({ camera }) => camera.lookAt(...TARGET)}
        >
          <color attach="background" args={["#3d6b2b"]} />

          <Lights />
          <Stage />

          <Suspense fallback={null}>
            <SlapScene autoPlay={autoPlay} />
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

      <div className="hud">
        <strong>Eel Slap</strong>
        move the mouse <em>left</em> and <em>right</em> to swing
      </div>
    </>
  );
}
