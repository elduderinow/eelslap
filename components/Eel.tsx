"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { useGLTF } from "@react-three/drei";
import { bendShape, ringShape } from "./slapTimeline";

// The hand-built eel is gone. This is the scanned Sketchfab lamprey Ray
// downloaded from Meshy, kept in `/public/models/eel.glb`. The old procedural
// one is at /tmp/Eel.handbuilt.bak if any of its shading is ever wanted back.
//
// The asset is skinned: one skin, 20 joints, a 12-bone spine running down -Z
// from the snout, plus a jaw and two front fins. It ships a 2.5s "Swim Cycle"
// clip which is never played — no AnimationMixer is created anywhere — because
// Ray wants a straight, rigid eel.
//
// Not playing the clip is NOT enough to get one, which is the trap this file
// fell into. See `straighten` below.

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
 * Resets a skinned mesh's skeleton to its actual bind pose.
 *
 * The GLB arrives posed, and not on the bind pose: its joint node transforms
 * are up to 27 degrees off on the spine and 35 on the fins, which skins the eel
 * into a curve before a single frame of animation has been asked for. Loading
 * the file and simply never creating an AnimationMixer therefore does *not*
 * give a straight fish — it gives whatever pose the exporter happened to leave
 * in the node hierarchy.
 *
 * The mesh's own vertex data is dead straight: sliced along its length, the
 * centre-line wanders 0.0001 units over a 0.6-unit body. So the whole curve is
 * the skeleton, and putting the bones back on the bind pose is all it takes.
 * `Skeleton.pose()` does exactly that, rebuilding every bone's local transform
 * from the inverse bind matrices the file already carries.
 *
 * This also has to happen for the bounds below to mean anything: those are
 * measured off `geometry.boundingBox`, which is the *unskinned* vertex data, so
 * until the skeleton is on the bind pose the bbox describes a straight fish
 * that is not the one on screen.
 */
function straighten(child: THREE.Object3D) {
  const skinned = child as THREE.SkinnedMesh;
  if (skinned.isSkinnedMesh) skinned.skeleton.pose();
}


/** How the fish is bent this frame. All angles in radians. */
export type EelBend = {
  /** Total curvature from tail to snout. Signed: which way the body lags. */
  curve: number;
  /** Where that curvature sits along the body. See `bendShape`. */
  curveBias: number;
  /** Amplitude of the post-impact ring. */
  ring: number;
  /** Where the ring sits along the body. See `ringShape`. */
  ringBias: number;
  /** Phase of that ring. */
  phase: number;
  /** Radians of phase the ring spans over the body, so the wobble travels. */
  wave: number;
};

export type EelRig = { bend(shape: EelBend): void };

type Spine = {
  bones: THREE.Bone[];
  /** Each bone's bind-pose local rotation, which every bend is applied on top of. */
  bind: THREE.Quaternion[];
  /** 0 at the tail, where the fish is driven, 1 at the snout, which is free. */
  u: number[];
  /**
   * Per-joint share of the total bend and of the ring, each summing to 1.
   *
   * Refilled every frame rather than measured once, because the shape they come
   * from is live from the panel now. Twelve evaluations and a sum, so it is
   * cheaper than the allocation that keeping them immutable would cost.
   */
  curveW: number[];
  ringW: number[];
  tip: THREE.Bone;
  /** The tip's transform relative to the model at bind. See `applyBend`. */
  tipBind: THREE.Matrix4;
};

/**
 * Finds the 12-bone spine and measures it.
 *
 * The chain is walked rather than sorted by name: the bones are `tail_12`
 * through `tail.011_1`, which sorts into the wrong order and would silently
 * bend the fish backwards.
 */
function buildSpine(model: THREE.Object3D): Spine | null {
  let skeleton: THREE.Skeleton | null = null;
  model.traverse((child) => {
    const mesh = child as THREE.SkinnedMesh;
    if (!skeleton && mesh.isSkinnedMesh) skeleton = mesh.skeleton;
  });
  if (!skeleton) return null;

  const inChain = new Set(
    (skeleton as THREE.Skeleton).bones.filter((b) => b.name.startsWith("tail")),
  );
  if (inChain.size === 0) return null;

  // The root of the chain is the one whose parent is not itself in it.
  let head: THREE.Bone | undefined;
  for (const b of inChain) if (!inChain.has(b.parent as THREE.Bone)) head = b;
  if (!head) return null;

  const bones: THREE.Bone[] = [];
  for (let b: THREE.Bone | undefined = head; b; ) {
    bones.push(b);
    b = b.children.find((c) => inChain.has(c as THREE.Bone)) as
      | THREE.Bone
      | undefined;
  }

  // Positions relative to the model, so the measurement survives wherever the
  // eel is parked in the scene.
  model.updateMatrixWorld(true);
  const toModel = model.matrixWorld.clone().invert();
  const at = bones.map((b) =>
    new THREE.Vector3().setFromMatrixPosition(
      new THREE.Matrix4().multiplyMatrices(toModel, b.matrixWorld),
    ),
  );

  // The chain runs snout -> tail, so arc length is accumulated from the far end
  // back: `u` has to be 0 at the tail, which is the end the swing drives.
  const gaps = at.map((p, i) => (i === 0 ? 0 : p.distanceTo(at[i - 1])));
  const total = gaps.reduce((a, b) => a + b, 0) || 1;
  let run = 0;
  const fromSnout = gaps.map((g) => (run += g) / total);
  const u = fromSnout.map((v) => 1 - v);

  const tip = bones[bones.length - 1];

  return {
    bones,
    bind: bones.map((b) => b.quaternion.clone()),
    u,
    curveW: u.map(() => 0),
    ringW: u.map(() => 0),
    tip,
    tipBind: new THREE.Matrix4().multiplyMatrices(toModel, tip.matrixWorld),
  };
}

/** Fills `out` with each joint's normalised share of a shape along the body. */
function share(
  out: number[],
  u: number[],
  shape: (v: number, bias: number) => number,
  bias: number,
) {
  let sum = 0;
  for (let i = 0; i < u.length; i++) sum += out[i] = shape(u[i], bias);
  // A shape can integrate to zero at an extreme setting; leave the joints flat
  // rather than dividing by it and handing NaN to every bone.
  if (Math.abs(sum) < 1e-9) return out.fill(0);
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

// Scratch, so the frame loop allocates nothing.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const axis = new THREE.Vector3();
const spin = new THREE.Quaternion();
const basis = new THREE.Matrix3();
const relative = new THREE.Matrix4();
const toModel = new THREE.Matrix4();

/**
 * Bends the spine, then puts the tail back where it was.
 *
 * That second half is the whole difficulty. Bone rotations propagate from
 * parent to child, and this chain runs **snout -> tail** — but the swing is
 * driven from the **tail**. Rotating the joints therefore pins the snout and
 * throws the tail off the anchor it is supposed to be pivoting about, so the
 * fish appears to slide sideways out of an invisible hand as it curves.
 *
 * A curve is a curve whichever end you build it from, so the shape is right
 * either way; only the rigid placement is wrong. Measuring where the tail
 * actually ended up and cancelling it on a group above the model fixes it
 * exactly, with no re-rooting of the skeleton and no second pass of bone maths.
 *
 * The bend axis is the world vertical — the same axis the swing turns about —
 * carried down into each bone's parent frame. Bending about a bone-local axis
 * instead would tip the curve out of the plane of the swing, because the body
 * is carrying a tilt.
 */
function applyBend(
  model: THREE.Object3D,
  correct: THREE.Group,
  spine: Spine,
  { curve, curveBias, ring, ringBias, phase, wave }: EelBend,
) {
  const { bones, bind, u, curveW, ringW, tip, tipBind } = spine;

  share(curveW, u, bendShape, curveBias);
  share(ringW, u, ringShape, ringBias);

  // A single non-finite angle writes a NaN quaternion into a bone, and from
  // then on the whole skinned mesh renders as nothing — with no error, and no
  // recovery even once the input is sane again, because the bad value is now
  // the pose. Cheaper to refuse the frame than to debug an invisible fish.
  if (!Number.isFinite(curve) || !Number.isFinite(ring) || !Number.isFinite(phase)) {
    return;
  }

  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    const angle =
      curve * curveW[i] + ring * Math.sin(phase - wave * u[i]) * ringW[i];

    if (angle === 0) {
      bone.quaternion.copy(bind[i]);
      continue;
    }

    const parent = bone.parent;
    if (parent) {
      basis.setFromMatrix4(parent.matrixWorld).invert();
      axis.copy(WORLD_UP).applyMatrix3(basis).normalize();
    } else {
      axis.copy(WORLD_UP);
    }

    // Bind orientation first, then the bend about the swing axis in the
    // parent's frame — so the joint turns the way the whole fish is turning.
    bone.quaternion.copy(spin.setFromAxisAngle(axis, angle)).multiply(bind[i]);
  }

  // Re-derive the tail's transform with the new pose on, and cancel it.
  model.updateMatrixWorld(true);
  // Measured relative to the model, so whatever this group's own matrix happens
  // to be left over from last frame cancels out of both sides.
  toModel.copy(model.matrixWorld).invert();
  relative.multiplyMatrices(toModel, tip.matrixWorld);
  correct.matrix.multiplyMatrices(tipBind, relative.invert());
  correct.matrixWorldNeedsUpdate = true;
}

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

export default function Eel({
  onBounds,
  rigRef,
}: {
  /**
   * Reports the fitted bind-pose bounds once the model is normalised, in the
   * space `<Eel />` itself is placed in — so a box drawn from it as a sibling
   * lines up with the fish and inherits whatever transform is above them both.
   */
  onBounds?: (box: THREE.Box3) => void;
  /** Filled in with the bend handle, so the frame loop can curve the body. */
  rigRef?: RefObject<EelRig | null>;
} = {}) {
  const { scene } = useGLTF(URL);
  const fit = useRef<THREE.Group>(null);
  const correct = useRef<THREE.Group>(null);

  // One instance, so the loaded scene is used directly rather than cloned.
  // SkinnedMesh needs SkeletonUtils.clone to survive a copy, and skipping that
  // is one less thing to get wrong.
  const model = useMemo(() => {
    scene.traverse((child) => {
      // The eel is scaled up hard and sits half behind the near plane, which
      // is exactly the case three's bounding-sphere cull gets wrong on a
      // skinned mesh. Cheaper to always draw it than to have it blink out.
      child.frustumCulled = false;

      straighten(child);
    });
    return scene;
  }, [scene]);

  // Built after `model`, so the skeleton is already back on its bind pose and
  // the measurements below describe a straight fish.
  const spine = useMemo(() => buildSpine(model), [model]);

  useEffect(() => {
    if (!rigRef) return;
    rigRef.current = {
      bend(shape) {
        if (spine && correct.current) {
          applyBend(model, correct.current, spine, shape);
        }
      },
    };
    return () => {
      rigRef.current = null;
    };
  }, [rigRef, model, spine]);

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

    // `box` is in the model's own space and `group.matrix` is the fit that was
    // just applied, so this is the same box the viewer ends up looking at.
    group.updateMatrix();
    onBounds?.(box.clone().applyMatrix4(group.matrix));
  }, [model, onBounds]);

  return (
    <group ref={fit}>
      {/* `applyBend` writes this group's matrix directly to cancel the tail
          drift, so three must not recompute it from position/rotation props. */}
      <group ref={correct} matrixAutoUpdate={false}>
        <primitive object={model} />
      </group>
    </group>
  );
}

useGLTF.preload(URL);
