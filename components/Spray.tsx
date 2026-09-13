"use client";

import { useMemo, useRef, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { useFrame } from "@react-three/fiber";

const COUNT = 120;
const GRAVITY = -2.6;
const LIFETIME = 1.1;

type Droplet = {
  origin: THREE.Vector3;
  velocity: THREE.Vector3;
  size: number;
};

/**
 * Slime thrown off the eel on contact. Each droplet's whole flight is ballistic
 * and seeded once, so its position is a closed-form function of the time since
 * the hit — scrub backwards and the spray sucks itself back into the fish.
 */
export default function Spray({
  sinceHitRef,
  origin,
  direction,
}: {
  sinceHitRef: RefObject<number>;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const droplets = useMemo<Droplet[]>(() => {
    // Deterministic seeding, not Math.random at frame time: the burst has to be
    // identical every pass over the hit.
    let seed = 1337;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    return Array.from({ length: COUNT }, () => ({
      // Spawned along the strip of cheek the flank covers, not a single point.
      origin: new THREE.Vector3(
        (rand() - 0.5) * 0.22,
        (rand() - 0.5) * 0.3,
        (rand() - 0.5) * 0.12,
      ).add(origin),
      velocity: direction
        .clone()
        .multiplyScalar(0.5 + rand() * 1.9)
        .add(
          new THREE.Vector3(
            (rand() - 0.5) * 1.5,
            (rand() - 0.2) * 1.2,
            rand() * 1.1,
          ),
        ),
      size: 0.004 + rand() * 0.011,
    }));
  }, [origin, direction]);

  useFrame(() => {
    const instanced = mesh.current;
    if (!instanced) return;

    const t = sinceHitRef.current;

    for (let i = 0; i < droplets.length; i++) {
      const drop = droplets[i];

      if (t <= 0 || t >= LIFETIME) {
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0);
      } else {
        dummy.position.set(
          drop.origin.x + drop.velocity.x * t,
          drop.origin.y + drop.velocity.y * t + 0.5 * GRAVITY * t * t,
          drop.origin.z + drop.velocity.z * t,
        );
        dummy.scale.setScalar(drop.size * (1 - (t / LIFETIME) ** 2));
      }

      dummy.updateMatrix();
      instanced.setMatrixAt(i, dummy.matrix);
    }

    instanced.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, COUNT]}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, 10, 8]} />
      <meshPhysicalNodeMaterial
        color="#b9d6bd"
        roughness={0.06}
        metalness={0}
        transmission={0.6}
        thickness={0.2}
        ior={1.33}
      />
    </instancedMesh>
  );
}
