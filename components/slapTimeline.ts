// The slap is a pure function of one number: how far through the cycle we are.
// Nothing here integrates over frames, because the scrub can run backwards and
// a simulation would smear rather than rewind. Pointer position in, pose out.
//
// All distances are in head-heights: the scanned head is normalised to exactly
// 1.0 tall and centred on the origin, so every constant below can be read as a
// fraction of the man's face.

export const CYCLE = 2.4;

const WINDUP_END = 0.98;
export const HIT_AT = 1.26;
const FOLLOW_END = 1.72;

/**
 * The point the eel lands on: his left cheekbone, which is screen-right with
 * the camera head-on. This is the same point `probeCheek` in `Man.tsx` snaps
 * to off the real mesh, and the two have to agree — aim higher and the eel
 * strikes the eye while the flesh wobbles down on the cheek.
 */
export const AIM: [number, number, number] = [0.28, -0.1, 0.3];

/**
 * The swing has no pivot of its own any more. The eel is laid along the
 * **camera -> face** vector: tail at the lens, snout on the cheek, so it is
 * seen almost end-on and reads as coming at him rather than across him. That
 * vector is recomputed every frame in `SlapScene`, so it survives an orbit.
 *
 * The arc is an azimuth spin about the vertical axis **through the camera**.
 * The tail therefore stays put at the lens and the head sweeps sideways, which
 * puts the fish on the face at angle 0 and off frame at the windup angle.
 */

const WINDUP_ANGLE = -1.0;
const HIT_ANGLE = 0;
const FOLLOW_ANGLE = 0.3;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export type SlapPose = {
  /** Azimuth of the swing, radians about Y through the camera. 0 lands on the face. */
  angle: number;
  /** 0 at rest, 1 mid-swing — how hard the body whips. */
  whip: number;
  /** Seconds since contact. Negative before the eel lands. */
  sinceHit: number;
};

export function poseAt(local: number): SlapPose {
  let angle: number;
  let whip: number;

  if (local < WINDUP_END) {
    // Held high and off frame-right, so the face is clear until the fish
    // actually arrives.
    const t = easeInOut(clamp01(local / WINDUP_END));
    angle = WINDUP_ANGLE * (0.8 + 0.2 * t);
    whip = 0.12 + t * 0.3;
  } else if (local < HIT_AT) {
    // The swing: short, and the only fast part of the cycle.
    const t = clamp01((local - WINDUP_END) / (HIT_AT - WINDUP_END));
    angle = WINDUP_ANGLE + (HIT_ANGLE - WINDUP_ANGLE) * easeOut(t);
    whip = 1;
  } else if (local < FOLLOW_END) {
    const t = easeOut(clamp01((local - HIT_AT) / (FOLLOW_END - HIT_AT)));
    angle = HIT_ANGLE + (FOLLOW_ANGLE - HIT_ANGLE) * t;
    whip = 1 - t * 0.55;
  } else {
    const t = easeInOut(clamp01((local - FOLLOW_END) / (CYCLE - FOLLOW_END)));
    angle = FOLLOW_ANGLE + (WINDUP_ANGLE * 0.8 - FOLLOW_ANGLE) * t;
    whip = 0.45 - t * 0.33;
  }

  return { angle, whip, sinceHit: local - HIT_AT };
}

/**
 * Impulse response of a damped spring, evaluated directly. This is what a
 * recoil simulation would settle into, except it can be sampled at any point
 * in time, in any order.
 */
export function recoilAt(sinceHit: number) {
  if (sinceHit <= 0) return 0;
  return 0.44 * Math.exp(-4.8 * sinceHit) * Math.sin(13.9 * sinceHit);
}

/**
 * Depth of the dent in the cheek, 0..1. Hard on contact, mostly gone in a
 * seventh of a second, with a small elastic overshoot as the flesh comes back.
 */
export function squashAt(sinceHit: number) {
  if (sinceHit <= 0) return 0;
  if (sinceHit < 0.045) return sinceHit / 0.045;
  return Math.max(0, Math.exp(-(sinceHit - 0.045) * 9) * Math.cos((sinceHit - 0.045) * 11));
}

/** How wet the slime decal reads: blooms on contact, then dries off slowly. */
export function slimeAt(sinceHit: number) {
  if (sinceHit <= 0) return 0;
  if (sinceHit < 0.06) return sinceHit / 0.06;
  return clamp01(1 - (sinceHit - 0.06) / 1.9);
}
