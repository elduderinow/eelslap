"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import * as THREE from "three/webgpu";
import { useFrame } from "@react-three/fiber";
import { button, folder, useControls } from "leva";
import Man, { type Side } from "./Man";
import Eel, { EEL_LENGTH, type EelRig } from "./Eel";
import {
  AIM,
  RING_HARMONIC,
  RING_HARMONIC_MIX,
  SWING,
  bendDrive,
  bendOnset,
  poseAt,
  ringAt,
  ringPhase,
  runFor,
  timingOf,
} from "./slapTimeline";

// The arm is gone on purpose. A modelled hand and sleeve read as a mannequin
// part floating in frame, and the original meme is shot tight enough that the
// fish may as well be swinging itself.
//
// `Spray.tsx` and the slime decals are still parked.

/** The point on the cheek the snout is aimed at, for the readout below. */
const FACE = new THREE.Vector3(...AIM);

/**
 * Where the tail hangs, and the body's tilt off level.
 *
 * `z` is the number that matters, and it is not where it looks best on its own.
 * The snout sweeps a circle about the vertical through this point, and with the
 * tail any closer than about 2.5 that circle **overshoots the head's own axis**
 * — at 90 degrees the fish enters around his mouth and comes out the back of
 * his skull. Measured against the real scan, an anchor at 1.86 puts the eel
 * inside his head for 25 degrees of the sweep.
 *
 * A head turn cannot save it. Turning moves his cheeks, not his centre line,
 * and the eel is coming through `x ≈ 0` where his head is 1.7 wide — it would
 * need to *translate* about 0.9. Nor is there time: contact to the midline is
 * ~10 degrees, about 7ms at that speed, against ~96ms for his recoil to reach
 * anything. The eel is through him before he has begun to move.
 *
 * At 2.70 the sweep clears him everywhere, by 0.10 more than the fish's own
 * half-thickness — the first value with real margin rather than a hairline, and
 * the margin is what keeps it clean once the body starts bending into the gap.
 *
 * The cost is that the snout passes 0.44 in front of the cheek instead of
 * touching it. That miss is almost entirely in **z**, and the camera looks
 * straight down -z: the error you can actually see is 0.06. It reads as a hit
 * and misses by a wide margin in three dimensions.
 */
const DEFAULT_TAIL = { x: 0, y: -0.68, z: 2.7 };
const DEFAULT_TILT = { x: 19.5, z: -2 };
const DEFAULT_SIZE = 1.09;

/** Formats a vector the way it would be typed back into the source. */
const fmt = (v: THREE.Vector3) =>
  `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;

export default function SlapScene({
  autoPlay,
  touch,
  slider,
  live,
}: {
  autoPlay: boolean;
  /** True on touch devices, where the bar drives instead of the pointer. */
  touch: boolean;
  /**
   * The bottom scrub bar, in degrees of yaw. It is the eel's pose whenever a
   * swing is not playing, and it is written back to while one is, so the thumb
   * tracks the blow instead of going stale.
   *
   * Deliberately a DOM node rather than React state: it is read and written
   * every frame, and state would re-render the whole scene on every drag.
   *
   * On desktop it is hidden and the **pointer** writes into it instead of a
   * thumb. Keeping it as the one place the yaw lives means the readout, the
   * contact crossings and the played swing all carry on not caring which of the
   * two is actually driving.
   */
  slider: RefObject<HTMLInputElement | null>;
  /** The live degree readout beside it. Written to from the frame loop. */
  live: RefObject<HTMLSpanElement | null>;
}) {
  // Seconds into the current swing, or null when the fish is hanging at rest.
  // A ref, not state: the swing is animation and must not re-render React.
  const playhead = useRef<number | null>(null);
  const hitFired = useRef(false);

  /**
   * Which way the swing in flight is going: `1` sweeps up the range and lands
   * the right cheek, `-1` comes back down and lands the left one.
   *
   * Not a toggle — it is read off **where the fish actually is** when the swing
   * starts, so it is literally "whichever side it was swung from". Clicking
   * slap repeatedly walks it back and forth across his face alternating cheeks,
   * and dragging the bar to the far side first makes the next one come back the
   * other way, with no separate state to get out of step.
   */
  const direction = useRef<1 | -1>(1);

  const startSwing = useRef(() => {});

  const { tail, tiltX, tiltZ, size, follow, bbox, axes } = useControls({
    eel: folder(
      {
        tail: { value: DEFAULT_TAIL, step: 0.01, label: "tail xyz" },
        tiltX: { value: DEFAULT_TILT.x, step: 0.5, label: "tilt x°" },
        tiltZ: { value: DEFAULT_TILT.z, step: 0.5, label: "tilt z°" },
        size: { value: DEFAULT_SIZE, min: 0.2, max: 3, step: 0.01 },
        follow: { value: 12, min: 1, max: 40, step: 0.5, label: "mouse follow" },
        bbox: { value: false, label: "show bbox" },
        axes: { value: false, label: "show tail axes" },
      },
      { collapsed: false },
    ),
  });

  // Four yaws: two rest angles either side of him, and the yaw at which the
  // snout reaches each cheek. Symmetric about 90, because the arc is.
  const { restRight, contactRight, contactLeft, restLeft, speed } = useControls({
    swing: folder(
      {
        restRight: { value: SWING.restRight, min: -180, max: 180, step: 0.1, label: "rest right°" },
        contactRight: { value: SWING.contactRight, min: -180, max: 180, step: 0.1, label: "contact right°" },
        contactLeft: { value: SWING.contactLeft, min: -180, max: 180, step: 0.1, label: "contact left°" },
        restLeft: { value: SWING.restLeft, min: -180, max: 180, step: 0.1, label: "rest left°" },
        speed: { value: 1, min: 0.2, max: 3, step: 0.05 },
        slap: button(() => startSwing.current()),
      },
      { collapsed: false },
    ),
  });

  // How the body curves, in three groups: the lag that bends it while it swings,
  // the ring it settles with after a blow, and a freeze for looking at either.
  //
  // Shipped at Ray's dial on 2026-09-13, which is a long slow travelling wave
  // rather than a sharp impact ring, and with the swing-driven lag off
  // altogether. Note `decay` at 0.2: the wobble e-folds over five seconds, so
  // it is effectively a permanent undulation once it has been set going. It is
  // still gated on a blow having landed, so the fish is straight on load until
  // the first slap.
  const {
    curve,
    straighten,
    curveBias,
    onsetTime,
    ringGain,
    ringHz,
    ringDecay,
    wave,
    ringBias,
    harmonic,
    harmonicMix,
    freeze,
    holdCurve,
    holdRing,
    holdPhase,
  } = useControls({
    curvature: folder(
      {
        curve: { value: 0, min: 0, max: 0.04, step: 0.0002, label: "lag gain" },
        straighten: { value: 0, min: 0, max: 0.2, step: 0.001, label: "outward pull" },
        // 1 keeps the bend down by the tail and lets the front whip; 0 arcs the
        // whole fish evenly like a banana.
        curveBias: { value: 0, min: 0, max: 1, step: 0.01, label: "curve along body" },
        onsetTime: { value: 0, min: 0, max: 0.25, step: 0.005, label: "onset s" },
      },
      { collapsed: false },
    ),
    wobble: folder(
      {
        ringGain: { value: 2, min: 0, max: 6, step: 0.01, label: "amount rad" },
        ringHz: { value: 0.5, min: 0.02, max: 20, step: 0.02, label: "Hz" },
        ringDecay: { value: 0.2, min: 0, max: 20, step: 0.05, label: "decay" },
        wave: { value: 5.65, min: 0, max: 24, step: 0.05, label: "wave along body" },
        // Past about 0.8 the head stops moving and it creases instead of
        // rippling. 0 wobbles the whole fish evenly.
        ringBias: { value: 0, min: 0, max: 1, step: 0.01, label: "ring along body" },
        harmonic: { value: RING_HARMONIC, min: 1, max: 6, step: 0.05, label: "2nd mode ×" },
        harmonicMix: { value: RING_HARMONIC_MIX, min: 0, max: 1, step: 0.01, label: "2nd mode mix" },
      },
      { collapsed: false },
    ),
    // Pins the body at a fixed shape so it can be judged without chasing a
    // three-hundred-millisecond animation. The same trick the neck has.
    freezeShape: folder(
      {
        freeze: { value: false, label: "freeze shape" },
        holdCurve: { value: 30, min: -90, max: 90, step: 0.5, label: "curve°" },
        holdRing: { value: 20, min: -90, max: 90, step: 0.5, label: "wobble°" },
        holdPhase: { value: 0, min: 0, max: 360, step: 1, label: "wave phase°" },
      },
      { collapsed: true },
    ),
  });

  /**
   * Where the pointer is across the viewport, 0 at the left edge and 1 at the
   * right. Null until it first moves, so the fish stays where it was parked
   * rather than snapping to the middle of the screen on load.
   */
  const pointerX = useRef<number | null>(null);

  useEffect(() => {
    if (touch) return;
    const onMove = (event: PointerEvent) => {
      // A finger dragging the bar also emits pointermove. Without this, the
      // frame a hybrid switches modes on would have both drivers fighting.
      if (event.pointerType === "touch") return;
      pointerX.current = THREE.MathUtils.clamp(
        event.clientX / window.innerWidth,
        0,
        1,
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [touch]);

  const [bounds, setBounds] = useState<THREE.Box3 | null>(null);
  const onBounds = useCallback((box: THREE.Box3) => setBounds(box), []);

  const rig = useRef<THREE.Group>(null);
  const eel = useRef<EelRig | null>(null);
  const slap = useRef<((force: number, side: Side) => void) | null>(null);

  const { x: tx, y: ty, z: tz } = tail;

  // The button closure is created once and reaches the live values through
  // here, so the rest angles can be re-dialled without rebuilding the panel.
  const ends = useRef({ restRight, restLeft });
  ends.current = { restRight, restLeft };

  startSwing.current = () => {
    const bar = slider.current;
    const from = bar ? bar.valueAsNumber : ends.current.restRight;
    const near = Math.abs(from - ends.current.restRight);
    const far = Math.abs(from - ends.current.restLeft);
    direction.current = near <= far ? 1 : -1;
    playhead.current = 0;
    hitFired.current = false;
  };

  const angles = useMemo(
    () => ({ restRight, contactRight, contactLeft, restLeft }),
    [restRight, contactRight, contactLeft, restLeft],
  );

  // The **idle** pose, which is what the panel is editing and the readout
  // reports. The swing overrides the yaw per frame in `useFrame`.
  const derived = useMemo(() => {
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(tiltX),
      THREE.MathUtils.degToRad(restRight),
      THREE.MathUtils.degToRad(tiltZ),
    );
    const anchor = new THREE.Vector3(tx, ty, tz);
    const reach = (yaw: number) =>
      new THREE.Vector3(EEL_LENGTH * size, 0, 0)
        .applyEuler(new THREE.Euler(euler.x, THREE.MathUtils.degToRad(yaw), euler.z))
        .add(anchor);

    return {
      euler,
      anchor,
      snout: reach(restRight),
      struck: reach(contactRight),
      dims: bounds ? bounds.getSize(new THREE.Vector3()).multiplyScalar(size) : null,
    };
  }, [tx, ty, tz, tiltX, tiltZ, restRight, contactRight, size, bounds]);

  const [, setReadout] = useControls("eel readout", () => ({
    snout: { value: "", editable: false, label: "snout (rest)" },
    struck: { value: "", editable: false, label: "snout (contact)" },
    tailAt: { value: "", editable: false, label: "tail" },
    length: { value: "", editable: false },
    box: { value: "", editable: false, label: "bbox w h d" },
    toFace: { value: "", editable: false, label: "contact → cheek" },
    swingFor: { value: "", editable: false, label: "swing time" },
  }));

  const written = useRef("");

  useEffect(() => {
    const { anchor, snout, struck, dims } = derived;
    const { t1, t2 } = timingOf(runFor(angles, 1));
    const next = {
      snout: fmt(snout),
      struck: fmt(struck),
      tailAt: fmt(anchor),
      length: (EEL_LENGTH * size).toFixed(3),
      box: dims
        ? `${dims.x.toFixed(3)} × ${dims.y.toFixed(3)} × ${dims.z.toFixed(3)}`
        : "measuring…",
      toFace: struck.distanceTo(FACE).toFixed(3),
      swingFor: `${t1.toFixed(3)} + ${t2.toFixed(3)} = ${(t1 + t2).toFixed(3)}s`,
    };
    const key = JSON.stringify(next);
    if (key === written.current) return;
    written.current = key;
    setReadout(next);
  }, [derived, angles, size, setReadout]);

  // Bar bounds follow the panel. Bounds before value: a min or max that
  // excludes the current value would clamp it.
  useEffect(() => {
    const bar = slider.current;
    if (!bar) return;
    const all = [restRight, contactRight, contactLeft, restLeft];
    bar.min = String(Math.min(...all));
    bar.max = String(Math.max(...all));
  }, [restRight, contactRight, contactLeft, restLeft, slider]);

  // Grabbing the bar cancels a swing in flight, so the drag wins instead of
  // being overwritten frame by frame until the swing runs out.
  useEffect(() => {
    const bar = slider.current;
    if (!bar) return;
    const cancel = () => {
      playhead.current = null;
    };
    bar.addEventListener("pointerdown", cancel);
    return () => bar.removeEventListener("pointerdown", cancel);
  }, [slider]);

  useEffect(() => {
    if (playhead.current !== null) return;
    if (slider.current) slider.current.value = String(restRight);
  }, [restRight, slider]);

  // Yaw last frame, so a manual drag can be differentiated into the angular
  // velocity and acceleration the bend is driven by, and so a contact can be
  // spotted as a crossing rather than a window.
  const lastYaw = useRef(restRight);
  const lastOmega = useRef(0);

  /**
   * Real seconds since the last blow, and how hard it was.
   *
   * One clock for both the played swing and a hand-scrubbed one. It used to be
   * read off the pose while playing and off a separate counter while not, which
   * meant the wobble was **cut off dead** the instant a swing finished — 0.2s
   * after contact, well before it had rung out. The ring outlives the swing
   * that caused it, so its clock has to as well.
   */
  const sinceHit = useRef(Number.POSITIVE_INFINITY);
  const hitForce = useRef(1);

  useFrame((state, delta) => {
    if (!rig.current) return;
    const dt = Math.max(delta, 1 / 240);

    if (autoPlay && playhead.current === null) startSwing.current();

    // Advanced before any blow can land, so the frame a blow lands on reads
    // zero rather than one frame's worth.
    sinceHit.current += dt;

    const land = (force: number, side: Side) => {
      slap.current?.(force, side);
      sinceHit.current = 0;
      hitForce.current = force;
    };

    const bar = slider.current;
    const run = runFor(angles, direction.current);
    const { t1, cycle } = timingOf(run);

    let yaw = bar ? bar.valueAsNumber : restRight;
    let omega: number;
    let alpha: number;
    let onset = 1;

    if (playhead.current !== null) {
      const local = (playhead.current += delta * speed);
      const pose = poseAt(local, run);
      yaw = pose.angle;
      // `speed` rescales time, so the derivatives scale with it too: once for
      // velocity, twice for acceleration.
      omega = pose.omega * speed;
      alpha = pose.alpha * speed * speed;
      onset = bendOnset(local / speed, onsetTime);

      if (!hitFired.current && local >= t1) {
        hitFired.current = true;
        land(1, direction.current > 0 ? 1 : -1);
      }

      if (local >= cycle) {
        playhead.current = null;
        yaw = run.end;
        // No flip needed: the fish is now parked at the far rest angle, so the
        // next swing reads its direction off that and comes back.
      }

      if (bar) bar.value = String(yaw);
    } else {
      // Desktop: the pointer is the transport. Left edge of the screen is the
      // left rest angle and the right edge the right one, matching the bar it
      // replaces — and matching where the fish visibly is.
      //
      // Eased rather than assigned, and that is not a nicety: the bend is
      // driven by the first and second derivatives of this angle, so a pointer
      // that jumps half the screen between two frames would hand the spine an
      // impulse and snap the fish inside out. The ease is what turns a
      // discontinuous input into something differentiable.
      if (!touch && pointerX.current !== null) {
        const target = restLeft + (restRight - restLeft) * pointerX.current;
        yaw =
          lastYaw.current +
          (target - lastYaw.current) * Math.min(dt * follow, 1);
        if (bar) bar.value = String(yaw);
      }

      // Dragged by hand. The bend is driven by the derivatives either way, so
      // the bar is differentiated to produce them — scrub fast and the fish
      // bends, scrub slowly and it stays straight.
      //
      // Differentiating pointer input twice amplifies every frame of jitter
      // into a spasm, so the velocity is smoothed before the second difference
      // and the result is capped. Smoothing state is fine here: it is a
      // property of the drag, not of the pose, so nothing about scrubbing
      // backwards depends on it.
      const raw = THREE.MathUtils.degToRad(yaw - lastYaw.current) / dt;
      omega = lastOmega.current + (raw - lastOmega.current) * Math.min(dt * 18, 1);
      alpha = THREE.MathUtils.clamp((omega - lastOmega.current) / dt, -200, 200);

      // A hand-scrubbed pass over a cheek lands a blow too, otherwise dragging
      // the fish through his face does nothing and the wobble never fires.
      const crossed = (at: number, sign: number) =>
        sign * (yaw - at) >= 0 && sign * (lastYaw.current - at) < 0;
      if (crossed(contactRight, 1)) {
        land(Math.min(Math.abs(omega) / 8, 1.5), 1);
      } else if (crossed(contactLeft, -1)) {
        land(Math.min(Math.abs(omega) / 8, 1.5), -1);
      }
    }

    lastYaw.current = yaw;
    lastOmega.current = omega;

    // The lag that bends it, tempered by the outward pull that straightens it.
    // `curve` is a gain on the acceleration; `ringGain` is already an angle.
    const drive = bendDrive(omega, alpha, straighten) * curve * onset;
    // Scaled by how hard the blow actually was, so a lazy drag past his cheek
    // gives a lazy wobble and a full swing gives the whole thing.
    const ring =
      ringAt(sinceHit.current, ringHz, ringDecay, harmonic, harmonicMix) *
      ringGain *
      hitForce.current;

    eel.current?.bend(
      freeze
        ? {
            curve: THREE.MathUtils.degToRad(holdCurve),
            curveBias,
            ring: THREE.MathUtils.degToRad(holdRing),
            ringBias,
            phase: THREE.MathUtils.degToRad(holdPhase),
            wave,
          }
        : {
            curve: drive,
            curveBias,
            ring,
            ringBias,
            phase: ringPhase(sinceHit.current, ringHz),
            wave,
          },
    );

    const shown = `${yaw.toFixed(1)}°`;
    if (live.current && live.current.textContent !== shown) {
      live.current.textContent = shown;
    }

    rig.current.rotation.set(
      THREE.MathUtils.degToRad(tiltX),
      THREE.MathUtils.degToRad(yaw),
      THREE.MathUtils.degToRad(tiltZ),
    );
  });

  return (
    <>
      <Man slapRef={slap} />

      {/* Outer group is the tail anchor: the position control puts it
          somewhere and every rotation spins about it. Inner group slides the
          fish forward half its own length, so the tail — not the middle — is
          what sits on that anchor. */}
      <group
        ref={rig}
        position={derived.anchor}
        rotation={derived.euler}
        scale={size}
      >
        {axes && <axesHelper args={[0.5 / size]} />}

        <group position={[EEL_LENGTH / 2, 0, 0]}>
          <Eel onBounds={onBounds} rigRef={eel} />
          {bbox && bounds && <EelBox box={bounds} />}
        </group>
      </group>
    </>
  );
}

/**
 * Wireframe of the eel's own bounds. Drawn as a sibling of the fish inside the
 * same group, so it is an **oriented** box: it rolls and yaws with the model
 * rather than re-fitting to an axis-aligned world box every time it turns.
 *
 * It is measured off the unskinned vertex data, so it describes the fish
 * straight. Once the spine is bending, expect the body to leave the box.
 */
function EelBox({ box }: { box: THREE.Box3 }) {
  const helper = useMemo(() => {
    const h = new THREE.Box3Helper(box, new THREE.Color("#ffe14d"));
    const material = h.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    h.renderOrder = 999;
    h.frustumCulled = false;
    return h;
  }, [box]);

  return <primitive object={helper} />;
}
