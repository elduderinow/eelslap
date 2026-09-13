"use client";

import * as THREE from "three/webgpu";
import { useMemo } from "react";
import { float, length, mix, smoothstep, uv, vec2, vec3 } from "three/tsl";

/**
 * The green screen. Not a flat fill: the original is a cheap cyclorama lit from
 * one side, so this is a vertical ramp with a soft vignette dropped over it.
 * Getting that unevenness right does more for the look than any amount of
 * shading on the head.
 */
export default function Stage() {
  const material = useMemo(() => {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: 0.98,
      metalness: 0,
    });

    const top = vec3(0.2, 0.44, 0.14);
    const bottom = vec3(0.31, 0.55, 0.19);

    const ramp = mix(bottom, top, smoothstep(float(0.1), float(0.95), uv().y));
    const vignette = smoothstep(
      float(0.28),
      float(0.62),
      length(uv().sub(vec2(0.46, 0.56))),
    );

    material.colorNode = mix(ramp, ramp.mul(0.42), vignette);

    return material;
  }, []);

  return (
    <mesh position={[0, 0, -2.2]} material={material} receiveShadow>
      <planeGeometry args={[14, 10]} />
    </mesh>
  );
}
