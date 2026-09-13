"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { useGLTF } from "@react-three/drei";

// The hand-built eel is gone. This is the scanned Sketchfab lamprey Ray
// downloaded from Meshy, kept in `/public/models/eel.glb`. The old procedural
// one is at /tmp/Eel.handbuilt.bak if any of its shading is ever wanted back.
//
// The asset is skinned and ships a "Swim Cycle" clip. We never play it: Ray
// asked for a straight, rigid eel, so the mesh renders in its bind pose and no
// mixer is created.

const URL = "/models/eel.glb";

/**
 * Nominal snout-to-tail length in head-heights, the unit the rest of the scene
 * works in. The GLB is normalised to exactly this below, so `SlapScene` can go
 * on treating the eel as a known-length rod without caring what the artist
 * modelled it at.
 */
export const EEL_LENGTH = 1.9;

/**
 * The model's long axis is +Z with the snout at the positive end. Everything
 * downstream aims the eel by pointing its **+X** at the target, so yaw it a
 * quarter turn: rotating +90 degrees about Y sends +Z to +X and leaves up
 * alone.
 */
const YAW = Math.PI / 2;

/**
 * Bind-pose bounds of a loaded scene, in that scene's own space.
 *
 * `Box3.setFromObject` is no good here: it measures in **world** space, and by
 * the time this runs the eel is already parented to a group that `SlapScene`
 * scales and parks on the camera, so it would measure the answer it is being
 * used to compute. Walking the geometry against the root's inverse keeps the
 * measurement local and idempotent.
 */
function localBounds(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const toLocal = root.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const scratch = new THREE.Box3();
  const matrix = new THREE.Matrix4();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    scratch.copy(mesh.geometry.boundingBox);
    scratch.applyMatrix4(matrix.multiplyMatrices(toLocal, mesh.matrixWorld));
    box.union(scratch);
  });

  return box;
}

export default function Eel() {
  const { scene } = useGLTF(URL);
  const fit = useRef<THREE.Group>(null);

  // One instance, so the loaded scene is used directly rather than cloned.
  // SkinnedMesh needs SkeletonUtils.clone to survive a copy, and skipping that
  // is one less thing to get wrong.
  const model = useMemo(() => {
    scene.traverse((child) => {
      // The eel is scaled up hard and sits half behind the near plane, which
      // is exactly the case three's bounding-sphere cull gets wrong on a
      // skinned mesh. Cheaper to always draw it than to have it blink out.
      child.frustumCulled = false;
    });
    return scene;
  }, [scene]);

  useLayoutEffect(() => {
    const group = fit.current;
    if (!group) return;

    const box = localBounds(model);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);

    // Longest axis is the fish. Read it rather than assuming Z, so a re-export
    // on different axes does not silently squash the model.
    const span = Math.max(size.x, size.y, size.z) || 1;
    const scale = EEL_LENGTH / span;

    group.scale.setScalar(scale);
    group.rotation.set(0, YAW, 0);
    // Put the centre of the fish on this group's origin, so the snout ends up
    // at +EEL_LENGTH / 2 and the tail at -EEL_LENGTH / 2 along X. That is the
    // contract `SlapScene` slides and aims against.
    group.position
      .copy(centre)
      .multiplyScalar(-scale)
      .applyEuler(new THREE.Euler(0, YAW, 0));
  }, [model]);

  return (
    <group ref={fit}>
      <primitive object={model} />
    </group>
  );
}

useGLTF.preload(URL);
