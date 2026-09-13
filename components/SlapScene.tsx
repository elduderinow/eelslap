"use client";

import { useRef } from "react";
import * as THREE from "three/webgpu";
import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import Man from "./Man";
import Eel, { EEL_LENGTH } from "./Eel";
import { AIM, CYCLE, HIT_AT, poseAt } from "./slapTimeline";
import { useScrub } from "./useScrub";

// The arm is gone on purpose. A modelled hand and sleeve read as a mannequin
// part floating in frame, and the original meme is shot tight enough that the
// fish may as well be swinging itself.
//
// `Spray.tsx` and the slime decals are still parked.

const FACE = new THREE.Vector3(...AIM);
const FORWARD = new THREE.Vector3(1, 0, 0);


/** Scrub speed, in cycle-units per second, that counts as a full-force blow. */
const FULL_FORCE_SPEED = 4;

// Scratch, so the frame loop allocates nothing.
const reach = new THREE.Vector3();
const tail = new THREE.Vector3();

export default function SlapScene({ autoPlay }: { autoPlay: boolean }) {
  const scrub = useScrub(autoPlay);

  // How far along the camera -> face line the eel's tail sits, as a fraction
  // of that distance. 0 puts it exactly on the lens, which is the pure form of
  // the aim but means the near end of the fish is at zero distance and fills
  // the whole frame. Winding it forward shortens the eel and pulls the tail
  // off the lens without changing the direction it points.
  const { tailAt } = useControls({
    eel: folder({ tailAt: { value: 0.55, min: 0, max: 0.92, step: 0.01, label: "tail from lens" } }, { collapsed: false }),
  });
  const anchor = useRef<THREE.Group>(null);
  const aim = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const slap = useRef<((force: number) => void) | null>(null);

  // Where in the cycle we were last frame, so a contact can be detected as a
  // crossing rather than a window. Scrubbing backwards past the hit does not
  // fire, and neither does the wrap at the end of the cycle.
  const previous = useRef(0);

  useFrame((state, delta) => {
    const local = scrub(state.clock.elapsedTime, delta) * CYCLE;
    const { angle } = poseAt(local);

    // The eel's axis is the camera -> face vector, every frame. Rebuilding it
    // from the live camera rather than baking a constant means an orbit or a
    // dolly re-aims the fish instead of leaving it stranded in the old plane.
    const camera = state.camera.position;
    reach.copy(FACE).sub(camera);
    const span = reach.length();
    reach.divideScalar(span || 1);

    // Slide the tail up the same line. The eel then runs from there to the
    // face, so the aim is untouched and only the length changes.
    tail.copy(reach).multiplyScalar(span * tailAt).add(camera);
    const distance = span * (1 - tailAt);

    if (anchor.current) {
      // The tail end is the anchor, and the whole rig spins about the vertical
      // through it. Azimuth only, so the fish stays level and the snout sweeps
      // horizontally onto the cheek.
      anchor.current.position.copy(tail);
      anchor.current.rotation.set(0, angle, 0);
    }

    // Aim the eel's own +X, its snout, straight down the reach. `setFromUnit-
    // Vectors` is done in the anchor's frame, which the azimuth then spins.
    aim.current?.quaternion.setFromUnitVectors(FORWARD, reach);

    if (body.current) {
      // Stretch the fish to exactly span lens to cheek, then shift it half its
      // own length forward so its tail, not its middle, sits on the anchor.
      const scale = distance / EEL_LENGTH;
      body.current.scale.setScalar(scale);
      body.current.position.set(EEL_LENGTH / 2, 0, 0);
    }

    if (previous.current < HIT_AT && local >= HIT_AT) {
      // How hard the blow lands is how fast the scrub was moving through it.
      const speed = (local - previous.current) / Math.max(delta, 1 / 240);
      const force = Math.min(Math.max(speed / FULL_FORCE_SPEED, 0.2), 1.5);
      slap.current?.(force);
    }

    previous.current = local;
  });

  return (
    <>
      <Man slapRef={slap} />

      {/* Three nested groups, outermost first: the anchor parked on the camera
          and spun in azimuth, the aim that points the eel down the camera ->
          face line, and the body slid and scaled to reach from one to the
          other. All three are driven from the frame loop above. */}
      <group ref={anchor}>
        <group ref={aim}>
          <group ref={body}>
            <Eel />
          </group>
        </group>
      </group>
    </>
  );
}
