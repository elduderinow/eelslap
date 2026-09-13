"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three/webgpu";
import { useFrame, useThree } from "@react-three/fiber";
import { useGLTF, useTexture } from "@react-three/drei";
import { button, folder, useControls } from "leva";
import {
  Fn,
  If,
  attribute,
  cos,
  cross,
  float,
  instanceIndex,
  materialNormal,
  mix,
  normalize,
  positionLocal,
  sin,
  smoothstep,
  storage,
  transformNormalToView,
  uniform,
  vec3,
} from "three/tsl";

const MODEL = "/models/LeePerrySmith/LeePerrySmith.glb";

/**
 * The uniform node types the slap rig passes around.
 *
 * These were each `ReturnType<typeof uniform>`, which named a usable node until @types/three
 * 0.186: `uniform` is an overload set there, so `ReturnType` picks the *last* overload and lands
 * on `UniformNode<unknown, unknown>` — a node with none of the TSL operators on it, so every
 * `.mul()` and `.xyz` downstream stops type-checking. Name the concrete node types instead.
 */
type FloatUniform = THREE.UniformNode<"float", number>;
type Vec3Uniform = THREE.UniformNode<"vec3", THREE.Vector3>;
type Vec4Uniform = THREE.UniformNode<"vec4", THREE.Vector4>;

/** Everything in the scene is measured in head-heights. */
const HEAD_HEIGHT = 1;

/**
 * The scan is a bust, not a head, so normalising on its bounding box puts the
 * origin somewhere in the collarbone and makes the head two thirds the size you
 * asked for. These two numbers re-centre on the head itself, measured off the
 * mesh: in bust-normalised units the head's midpoint sits at y = 0.19 and it
 * spans 0.62. Everything downstream can then treat the face as unit-sized.
 */
const HEAD_CENTRE_Y = 0.19;
const HEAD_SPAN = 0.62;

/** The head sits on its neck, so anything that moves it turns about here. */
const NECK_Y = -0.45;

/**
 * Where the neck actually is, measured off the mesh by taking the width of the
 * bust in horizontal bands. The shoulders run 1.4 to 1.7 wide below y = -0.7,
 * the neck pinches to 0.48 between -0.5 and -0.3, and the jaw flares out again
 * above -0.2. So the bend ramps in across that pinch and the torso below it
 * barely moves.
 */
const NECK_BOTTOM = -0.72;
const NECK_TOP = -0.22;
const NECK_PIVOT_Y = -0.62;

/** The shoulders are not rigid either, they just follow far less than the head. */
const SHOULDER_FOLLOW = 0.08;

/** A head rolls less than it yaws. */
const ROLL_RATIO = 0.45;

/** How long the eel is considered to be in contact with the face, in seconds. */
const CONTACT_TIME = 0.09;

/** How long the head keeps answering a blow before it is back at rest. */
const RECOIL_TIME = 4;

/**
 * Turns the jelly's brush strength into a rigid swing. The brush is a
 * displacement in head-heights and the swing is radians, so they need a
 * conversion rather than sharing a slider directly.
 */
const SLAP_GAIN = 5;

/**
 * Loads the scanned head from the three.js decals example and normalises it:
 * geometry is centred on the origin and scaled to exactly one unit tall, so the
 * object transform stays identity.
 */
function useHeadGeometry() {
  const gltf = useGLTF(MODEL);

  return useMemo(() => {
    let source: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((child) => {
      if (!source && (child as THREE.Mesh).isMesh) {
        source = (child as THREE.Mesh).geometry;
      }
    });
    if (!source) throw new Error("no mesh in " + MODEL);

    const geometry = (source as THREE.BufferGeometry).clone();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const centre = box.getCenter(new THREE.Vector3());
    const scale = HEAD_HEIGHT / (box.max.y - box.min.y);

    // Bust-normalised first...
    geometry.translate(-centre.x, -centre.y, -centre.z);
    geometry.scale(scale, scale, scale);
    // ...then re-framed on the head, so y = 0 is between the eyes and the
    // crown-to-chin distance is 1.
    geometry.translate(0, -HEAD_CENTRE_Y, 0);
    geometry.scale(1 / HEAD_SPAN, 1 / HEAD_SPAN, 1 / HEAD_SPAN);
    geometry.computeBoundingBox();

    return geometry;
  }, [gltf]);
}

/**
 * Finds where a slap aimed at the cheek actually lands, by raycasting the real
 * surface rather than guessing a coordinate. Returns the contact point and the
 * outward surface normal there.
 */
function probeCheek(geometry: THREE.BufferGeometry) {
  const mesh = new THREE.Mesh(geometry);
  const raycaster = new THREE.Raycaster();

  // Come in from frame-right and slightly in front, the way the eel arrives,
  // aimed at a point just below the eye line.
  const origin = new THREE.Vector3(0.9, -0.08, 1.1);
  const target = new THREE.Vector3(0, -0.1, 0);
  raycaster.set(origin, target.clone().sub(origin).normalize());

  const hit = raycaster.intersectObject(mesh, false)[0];
  if (!hit) {
    // The scan should always be hit from there, but never let a miss take the
    // scene down: fall back to a plausible cheek.
    return {
      point: new THREE.Vector3(0.28, -0.1, 0.3),
      normal: new THREE.Vector3(0.6, 0, 0.8).normalize(),
    };
  }

  return {
    point: hit.point.clone(),
    normal: (hit.normal ?? new THREE.Vector3(0, 0, 1)).clone().normalize(),
  };
}

/**
 * The `webgpu_compute_geometry` jelly, retargeted from a pointer brush to a
 * slap. Two storage buffers per vertex, position and velocity, integrated on
 * the GPU against a spring back to the rest pose. The wobble therefore
 * propagates outward from wherever the eel landed and settles on its own,
 * which no closed-form dent does.
 *
 * This is the one stateful thing in the scene. It is only ever driven forwards,
 * so the scrub still owns the swing and the wobble just answers to it.
 */
const jelly = Fn(
  ({
    renderer,
    geometry,
    uHit,
    uPush,
    uElasticity,
    uDamping,
    uBrushSize,
    uNonlinear,
  }: {
    renderer: THREE.WebGPURenderer;
    geometry: THREE.BufferGeometry;
    uHit: Vec4Uniform;
    uPush: Vec3Uniform;
    uElasticity: FloatUniform;
    uDamping: FloatUniform;
    uBrushSize: FloatUniform;
    uNonlinear: FloatUniform;
  }) => {
    const count = geometry.attributes.position.count;

    const positionBaseAttribute = geometry.attributes.position;
    const positionStorageBufferAttribute = new THREE.StorageBufferAttribute(
      count,
      3,
    );
    const speedBufferAttribute = new THREE.StorageBufferAttribute(count, 3);

    geometry.setAttribute("storagePosition", positionStorageBufferAttribute);

    // `storage()` is typed for StorageBufferAttribute, but reading a plain
    // vertex attribute as a read-only storage buffer is exactly what the
    // example does and what the backend supports.
    const positionAttribute = storage(
      positionBaseAttribute as unknown as THREE.StorageBufferAttribute,
      "vec3",
      count,
    );
    const positionStorageAttribute = storage(
      positionStorageBufferAttribute,
      "vec3",
      count,
    );
    const speedAttribute = storage(speedBufferAttribute, "vec3", count);

    const basePosition = positionAttribute.element(instanceIndex);
    const currentPosition = positionStorageAttribute.element(instanceIndex);
    const currentSpeed = speedAttribute.element(instanceIndex);

    const computeInit = Fn(() => {
      currentPosition.assign(basePosition);
    })().compute(count);

    const computeUpdate = Fn(() => {
      // The head geometry sits at identity, so this is all local space and
      // there is no world matrix to fight with.
      If(uHit.w.greaterThan(0), () => {
        const dist = currentPosition.distance(uHit.xyz);

        // A slap drives the surface along the blow, it does not pull the face
        // towards a point the way the example's pinch brush does.
        const power = uBrushSize.sub(dist).max(0).mul(uHit.w);

        currentPosition.addAssign(uPush.mul(power));
      });

      // The example's law is `elasticity * distance * (base - current)`, which
      // is nonlinear: the further a vertex is pushed the stiffer its spring, so
      // it rings faster. Vertices near the impact are pushed further than ones
      // at the brush edge, they drift out of phase, and the result reads as
      // concentric ripples on water rather than as flesh.
      //
      // A linear force keeps the whole patch in phase, so it moves and settles
      // as one pad of tissue. `uNonlinear` at 1 restores the example's look.
      const distance = basePosition.distance(currentPosition);
      const stiffness = uElasticity.mul(
        float(1).sub(uNonlinear).add(distance.mul(uNonlinear)),
      );
      const force = stiffness.mul(basePosition.sub(currentPosition));

      currentSpeed.addAssign(force);
      currentSpeed.mulAssign(uDamping);

      currentPosition.addAssign(currentSpeed);
    })()
      .compute(count)
      .setName("Slap Jelly");

    computeUpdate.onInit(() => renderer.compute(computeInit));

    return computeUpdate;
  },
);

/** A TSL vec3 expression, whatever concrete node type produced it. */
type Vec3Node = THREE.Node<"vec3">;

/**
 * Turns a rigid head rotation into a neck that bends. The rotation angle is
 * weighted by height, so the shoulders keep `SHOULDER_FOLLOW` of it and the
 * head gets all of it, with the transition across the pinch of the neck.
 *
 * Rotating the group instead, which is what this replaced, swings the whole
 * bust: the shoulders travel with the jaw and the man reads as a bust on a
 * turntable rather than someone being hit.
 */
function neckBend(
  basePosition: Vec3Node,
  uSwing: FloatUniform,
  uShove: FloatUniform,
) {
  const weight = mix(
    float(SHOULDER_FOLLOW),
    float(1),
    smoothstep(float(NECK_BOTTOM), float(NECK_TOP), basePosition.y),
  );

  const yaw = uSwing.mul(weight);
  const roll = yaw.mul(ROLL_RATIO);

  const cy = cos(yaw);
  const sy = sin(yaw);
  const cr = cos(roll);
  const sr = sin(roll);

  // Yaw about Y, then roll about Z. Written out rather than built as a matrix
  // because the angle is per-vertex, so there is no single matrix to build.
  const turn = (v: Vec3Node) => {
    const yawed = vec3(
      v.x.mul(cy).add(v.z.mul(sy)),
      v.y,
      v.z.mul(cy).sub(v.x.mul(sy)),
    );
    return vec3(
      yawed.x.mul(cr).sub(yawed.y.mul(sr)),
      yawed.x.mul(sr).add(yawed.y.mul(cr)),
      yawed.z,
    );
  };

  // The neck bends about its base, not about the origin between the eyes.
  const pivoted = basePosition.sub(vec3(0, float(NECK_PIVOT_Y), 0));
  const position = turn(pivoted)
    .add(vec3(0, float(NECK_PIVOT_Y), 0))
    .add(vec3(uShove.mul(weight), 0, 0));

  // The shading has to follow the bend, or the turn only moves the silhouette.
  //
  // Doing that by rotating the object-space normal and handing the difference
  // to `transformNormalToView` does not work: that helper **normalises** what
  // it is given, so a small delta comes back out at unit length and swamps the
  // real normal. The face goes flat and washed out and the crown creases.
  //
  // Instead, rotate the already-mapped view-space normal directly. For small
  // angles a rotation is `n + omega x n`, where omega is the rotation vector,
  // here the object's Y and Z axes taken into view space and scaled by the two
  // angles. Those axes are unit length, so normalising them is harmless.
  //
  // This is added to `materialNormal` rather than assigned to `normalNode`
  // outright: NodeMaterial.setupNormal() takes normalNode in place of the
  // mapped normal, so assigning it throws away every pore of the normal map.
  const omega = transformNormalToView(vec3(0, 1, 0))
    .mul(yaw)
    .add(transformNormalToView(vec3(0, 0, 1)).mul(roll));

  const normal = normalize(materialNormal.add(cross(omega, materialNormal)));

  return { position, normal };
}

export default function Man({
  slapRef,
}: {
  /** Filled in with the trigger so the eel can land a blow on contact. */
  slapRef?: RefObject<((force: number) => void) | null>;
}) {
  const geometry = useHeadGeometry();
  const [colorMap, specularMap, normalTexture] = useTexture([
    "/models/LeePerrySmith/Map-COL.jpg",
    "/models/LeePerrySmith/Map-SPEC.jpg",
    "/models/LeePerrySmith/Infinite-Level_02_Tangent_SmoothUV.jpg",
  ]);

  const pose = useRef<THREE.Group>(null);

  // Where the blow lands, measured off the mesh so the defaults are already on
  // the cheek rather than floating in front of it.
  const contact = useMemo(() => probeCheek(geometry), [geometry]);

  // Seconds left in the current contact window. Nothing else in the scene is
  // stateful; this one is, because the jelly is.
  const contactLeft = useRef(0);
  const strength = useRef(0);

  // How long ago the last blow landed. Drives the rigid recoil.
  const sinceHit = useRef(Number.POSITIVE_INFINITY);

  /** Multiplier on every blow, live from the panel. Read through a ref so the
   *  trigger below stays stable and can be handed to the eel once. */
  const gain = useRef(0.22);

  const fire = (force = 1) => {
    strength.current = gain.current * force;
    contactLeft.current = CONTACT_TIME;
    sinceHit.current = 0;
  };

  useEffect(() => {
    if (!slapRef) return;
    slapRef.current = fire;
    return () => {
      slapRef.current = null;
    };
    // `fire` only touches refs, so it never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slapRef]);

  const {
    elasticity,
    damping,
    brushSize,
    brushStrength,
    water,
    turn,
    shove,
    recoilHz,
    settle,
    hold,
  } = useControls({
    // Defaults are Ray's, read off his phone on 2026-09-13.
    slap: folder(
      {
        elasticity: { value: 1, min: 0, max: 1, step: 0.01 },
        damping: { value: 0.74, min: 0.5, max: 0.995, step: 0.001 },
        brushSize: { value: 0.49, min: 0.05, max: 0.8, step: 0.01 },
        brushStrength: { value: 0.22, min: 0, max: 1, step: 0.01 },
        water: { value: false, label: "water ripple" },
        slap: button(() => fire()),
      },
      { collapsed: false },
    ),
    recoil: folder(
      {
        turn: { value: 1.2, min: 0, max: 1.2, step: 0.01 },
        shove: { value: 0.17, min: 0, max: 0.3, step: 0.005 },
        recoilHz: { value: 2.6, min: 0.3, max: 6, step: 0.05, label: "wobble Hz" },
        settle: { value: 3.9, min: 0.5, max: 12, step: 0.1 },
        // Pins the bend at a fixed angle so the neck shape can be judged
        // without chasing a four-frame animation. 0 hands it back to the slap.
        hold: { value: 0, min: -0.8, max: 0.8, step: 0.01 },
      },
      { collapsed: true },
    ),
  });


  const { material, uniforms } = useMemo(() => {
    // Do NOT set flipY = false here. That is the glTF convention and it is
    // wrong for this asset: the example loads all three with a plain
    // TextureLoader, so flipY stays true. Flipping them slides the whole atlas
    // about 0.2 in UV and the face lands low, eyebrows on the eyelids, lips
    // on the chin. It looks like bad skin rather than a bad lookup.
    colorMap.colorSpace = THREE.SRGBColorSpace;
    specularMap.colorSpace = THREE.SRGBColorSpace;
    for (const t of [colorMap, specularMap, normalTexture]) {
      t.flipY = true;
      t.needsUpdate = true;
    }

    // xyz is the contact point, w is how hard the blow is landing this frame.
    const uHit = uniform(new THREE.Vector4(0, 0, 0, 0));
    // The direction the surface is driven: into the face along the inward
    // normal at the contact point.
    const uPush = uniform(contact.normal.clone().negate());
    const uElasticity = uniform(0.4);
    const uDamping = uniform(0.94);
    const uBrushSize = uniform(0.25);
    // 0 is a linear spring (flesh), 1 is the example's amplitude-stiffened one
    // (water). Kept switchable so the two can be compared side by side.
    const uNonlinear = uniform(0);
    // The rigid part of the recoil, applied in the vertex stage so the neck can
    // bend rather than the whole bust swinging.
    const uSwing = uniform(0);
    const uShove = uniform(0);

    // The `webgl_materials_normalmap` example's skin, which is the decals
    // example's with the normal map actually driven hard: full normalScale,
    // brighter specular, and the specular map read as sRGB rather than linear.
    const material = new THREE.MeshPhongNodeMaterial({
      color: new THREE.Color(0xefefef),
      map: colorMap,
      specularMap,
      normalMap: normalTexture,
      // Full scale. Anything less and the pores and brow creases flatten out,
      // which is the whole point of this map.
      normalScale: new THREE.Vector2(1, 1),
      specular: new THREE.Color(0x222222),
      shininess: 35,
    });

    return {
      material,
      uniforms: {
        uHit,
        uPush,
        uElasticity,
        uDamping,
        uBrushSize,
        uNonlinear,
        uSwing,
        uShove,
      },
    };
  }, [colorMap, specularMap, normalTexture, contact]);

  useFrame((state, delta) => {
    const { uHit, uElasticity, uDamping, uBrushSize, uNonlinear } = uniforms;

    uElasticity.value = elasticity;
    uDamping.value = damping;
    uBrushSize.value = brushSize;
    uNonlinear.value = water ? 1 : 0;

    // Hold the contact point steady and open the throttle for the length of the
    // blow only. `w` is the per-frame push, so it has to go back to zero or the
    // face keeps being hit.
    uHit.value.set(
      contact.point.x,
      contact.point.y,
      contact.point.z,
      contactLeft.current > 0 ? strength.current : 0,
    );

    if (contactLeft.current > 0) contactLeft.current -= delta;
    if (sinceHit.current < RECOIL_TIME) sinceHit.current += delta;

    if (!pose.current) return;

    // Rigid recoil. A slap turns the whole head about the neck before any of
    // the flesh does anything, and the jelly is secondary to it. Closed form,
    // the impulse response of a damped spring, so it stays a pure function of
    // time since contact and can be rewound with the scrub later.
    const t = sinceHit.current;
    const swing =
      t < RECOIL_TIME
        ? Math.exp(-settle * t) * Math.sin(recoilHz * 2 * Math.PI * t)
        : 0;

    // The blow drives the head along `uPush`, so the turn follows its sign:
    // hit on the right cheek and the face swings to the left.
    const drive = swing * strength.current * SLAP_GAIN;
    const lateral = Math.sign(uniforms.uPush.value.x) || -1;

    // Handed to the vertex stage rather than applied here. Rotating the group
    // would take the shoulders with it.
    uniforms.uSwing.value = hold !== 0 ? hold : drive * turn * lateral;
    uniforms.uShove.value =
      hold !== 0 ? (hold / 0.4) * shove : drive * shove * lateral;

    // Breathing, so he is never a statue. NECK_Y is the group's rest position,
    // assigning y outright here lifts the head off the neck.
    pose.current.position.y =
      NECK_Y + Math.sin(state.clock.elapsedTime * 1.5) * 0.004;
  });

  // The eel's swing speed is what actually sets the force now. The slider is a
  // gain on top of it, and still the whole story for the panel's slap button.
  gain.current = brushStrength;

  return (
    <>
      <group ref={pose} position={[0, NECK_Y, 0]}>
        <group position={[0, -NECK_Y, 0]}>
          <JellyHead
            geometry={geometry}
            material={material}
            uniforms={uniforms}
          />
        </group>
      </group>
    </>
  );
}

/**
 * The jelly compute has to be built with a live renderer in hand, which only
 * exists inside the canvas, so it is wired up here rather than in the material
 * memo above.
 */
function JellyHead({
  geometry,
  material,
  uniforms,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshPhongNodeMaterial;
  uniforms: {
    uHit: Vec4Uniform;
    uPush: Vec3Uniform;
    uElasticity: FloatUniform;
    uDamping: FloatUniform;
    uBrushSize: FloatUniform;
    uNonlinear: FloatUniform;
    uSwing: FloatUniform;
    uShove: FloatUniform;
  };
}) {
  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;

  useMemo(() => {
    // WebGPURenderer silently falls back to a WebGL2 backend where the machine
    // has no WebGPU, and that backend has no compute shaders. Wiring the jelly
    // up anyway would point `positionNode` at a storage buffer nothing ever
    // fills, and the head would collapse to a point. Better a still face than
    // no face.
    const backend = gl.backend as unknown as { isWebGPUBackend?: boolean };
    const canCompute = backend?.isWebGPUBackend === true;

    if (canCompute) {
      // `geometryNode` is typed as a thunk, but the compute node returned here
      // is what NodeMaterial actually bypasses into the stack.
      material.geometryNode = jelly({
        renderer: gl,
        geometry,
        ...uniforms,
      }) as unknown as THREE.NodeMaterial["geometryNode"];
    } else {
      // WebGPURenderer silently falls back to a WebGL2 backend where the
      // machine has no WebGPU, and that backend has no compute shaders. Reading
      // `storagePosition` there points at a buffer nothing ever fills and the
      // head collapses to a point, so the flesh wobble is dropped. The neck
      // bend below is ordinary vertex work and survives either way.
      console.warn(
        "eelslap: no WebGPU backend, flesh wobble disabled (neck bend still runs)",
      );
    }

    // The node type has to be named: `attribute()` infers `unknown` without it, and the vec3
    // operators `neckBend` uses are only on a typed node. It is the storage buffer's real layout.
    const base = canCompute
      ? attribute("storagePosition", "vec3")
      : positionLocal;
    const { position, normal } = neckBend(base, uniforms.uSwing, uniforms.uShove);

    material.positionNode = position;
    material.normalNode = normal;
    material.needsUpdate = true;
  }, [gl, geometry, material, uniforms]);

  return <mesh geometry={geometry} material={material} />;
}

useGLTF.preload(MODEL);
