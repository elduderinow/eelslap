// The slap is a pure function of one number: how far through the swing we are.
// Nothing here integrates over frames, so the pose can be sampled at any point
// in any order — which is what lets the scrub bar run the whole thing backwards.
//
// All distances are in head-heights: the scanned head is normalised to exactly
// 1.0 tall and centred on the origin, so every constant below can be read as a
// fraction of the man's face.

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * The two cheeks, as the points the snout is aimed at. The right one is
 * measured off the mesh by `probeCheek` in `Man.tsx`; the left is its mirror,
 * and the whole swing is symmetric about the midline in the same way.
 */
export const AIM: [number, number, number] = [0.28, -0.1, 0.3];
export const AIM_LEFT: [number, number, number] = [-0.28, -0.1, 0.3];

/**
 * The swing, as four yaws about the tail, in degrees.
 *
 * The eel hangs off-frame at one of two rest angles and sweeps the whole way
 * across to the other, so which cheek it lands on is decided by which side it
 * was swung from: going up the range it reaches the right cheek first, coming
 * back down it reaches the left one first. It only ever lands the near one.
 *
 * The contact angles are the yaws at which the snout is closest to each
 * cheekbone, measured against the real head mesh with the tail anchored where
 * `SlapScene` parks it. They sit either side of 90 because the arc is
 * symmetric about the midline.
 *
 * The eel does NOT touch him at these angles: it passes about a third of a
 * head-height in front. That is deliberate — see the anchor note in
 * `SlapScene`, which explains why the miss is invisible and why it has to be
 * there at all.
 */
export type SwingAngles = {
  /** Rest angle on the right, where the fish hangs before a left-going swing. */
  restRight: number;
  /** Yaw at which the snout reaches the right cheek. */
  contactRight: number;
  /** Yaw at which the snout reaches the left cheek. */
  contactLeft: number;
  /** Rest angle on the left. */
  restLeft: number;
};

export const SWING: SwingAngles = {
  restRight: 21,
  contactRight: 83.5,
  contactLeft: 96.5,
  restLeft: 160,
};

/** One run of the swing, resolved to the direction it is actually travelling. */
export type SwingRun = { start: number; contact: number; end: number };

/**
 * Picks the three angles for a swing leaving the given side. `+1` sweeps up the
 * range (right to left, landing the right cheek); `-1` sweeps back down it
 * (left to right, landing the left cheek).
 */
export function runFor(angles: SwingAngles, direction: 1 | -1): SwingRun {
  return direction > 0
    ? { start: angles.restRight, contact: angles.contactRight, end: angles.restLeft }
    : { start: angles.restLeft, contact: angles.contactLeft, end: angles.restRight };
}

/** How long the strike takes, in seconds. Everything else is derived from it. */
export const STRIKE_TIME = 0.16;

/**
 * Timing of one swing.
 *
 * The strike is at constant angular acceleration and the follow-through at
 * constant deceleration, with the angular velocity **matched across contact**.
 * That matters more than it sounds: the bend below is driven by the
 * derivatives of this curve, so a kink here becomes a visible pop in the fish
 * on the exact frame of the blow.
 *
 * The previous easing pair (ease-in then ease-out) had the eel *speeding up*
 * from 10.7 to 26.2 rad/s as it hit the face, which is both wrong and the worst
 * possible place to put a discontinuity. Accelerate in, decelerate out: one
 * continuous velocity, and the sign of the acceleration still flips exactly at
 * contact, which is what makes the fish whip round the other way as it lands.
 *
 * The follow-through's duration is not a free parameter — it is whatever it
 * takes to cover the remaining angle from the contact velocity down to a stop.
 */
export function timingOf({ start, contact, end }: SwingRun) {
  const strike = (contact - start) * DEG;
  const follow = (end - contact) * DEG;
  const t1 = STRIKE_TIME;

  // Contact velocity, from covering `strike` in `t1` at constant acceleration.
  const vc = (2 * strike) / t1;
  // Decelerating from `vc` to a standstill across `follow` takes exactly this.
  const t2 = Math.abs(vc) < 1e-6 ? 0 : (2 * follow) / vc;

  return {
    t1,
    t2,
    vc,
    a1: (2 * strike) / (t1 * t1),
    a2: t2 === 0 ? 0 : -vc / t2,
    cycle: t1 + t2,
  };
}

export type SlapPose = {
  /** Yaw about the vertical through the tail, in degrees. */
  angle: number;
  /** Angular velocity, rad/s. Signed with the direction of travel. */
  omega: number;
  /** Angular acceleration, rad/s². Flips sign at contact. */
  alpha: number;
  /** Seconds since contact. Negative before the eel lands. */
  sinceHit: number;
};

/** @param local Seconds into the swing, 0 at the click. */
export function poseAt(local: number, run: SwingRun): SlapPose {
  const { t1, vc, a1, a2, cycle } = timingOf(run);

  if (local <= 0) {
    return { angle: run.start, omega: 0, alpha: 0, sinceHit: -t1 };
  }

  if (local < t1) {
    return {
      angle: run.start + 0.5 * a1 * local * local * RAD,
      omega: a1 * local,
      alpha: a1,
      sinceHit: local - t1,
    };
  }

  if (local < cycle) {
    const t = local - t1;
    return {
      angle: run.contact + (vc * t + 0.5 * a2 * t * t) * RAD,
      omega: vc + a2 * t,
      alpha: a2,
      sinceHit: t,
    };
  }

  return { angle: run.end, omega: 0, alpha: 0, sinceHit: local - t1 };
}

/**
 * How fast the bend is allowed to arrive, in seconds.
 *
 * The strike runs at constant acceleration, so `alpha` is at full value on the
 * very first frame of the swing — and with no speed yet to straighten the fish,
 * that is also where the bend is largest. Applied raw it appears in one frame,
 * which reads as a glitch rather than a whip. This ramps it on over a couple of
 * frames without touching the motion itself: the yaw is untouched, only how
 * quickly the body answers it.
 */
export const BEND_ONSET = 0.04;

export function bendOnset(local: number, onset = BEND_ONSET) {
  if (onset <= 0) return 1;
  const t = clamp01(local / onset);
  return t * t * (3 - 2 * t);
}

/**
 * How hard the body is bent, before the shape along it is applied.
 *
 * Two forces act on a bendy rod swung from one end, and they are perpendicular
 * to each other, so they are two terms rather than one:
 *
 *  - **Angular acceleration** bends it. The tail is the driven end and the head
 *    has inertia, so the head lags behind whenever the tail is being whipped
 *    round. This is the numerator, and it is signed: it flips at contact, which
 *    is what throws the head forward past the tail on the follow-through.
 *  - **The outward pull** straightens it. Centrifugal force acts along the body
 *    and puts it in tension, which stiffens it against sideways deflection —
 *    the same reason a spun chain goes straight. This is the denominator, and
 *    it grows as the square of the speed.
 *
 * The two together give the shape you actually see: bent hard at the start of
 * the swing where there is acceleration but no speed yet, straightening as it
 * winds up, nearly straight as it arrives at the face, then snapping the other
 * way as it decelerates past him.
 */
export function bendDrive(omega: number, alpha: number, straighten: number) {
  return alpha / (1 + straighten * omega * omega);
}

/**
 * The wobble after the blow: a damped ring, closed form so it can be scrubbed
 * backwards like everything else here.
 *
 * This is deliberately NOT the kind of spring simulation the man's cheek uses.
 * His flesh is a stateful GPU solve that only ever runs forwards; the eel has
 * to rewind with the bar, so it gets an impulse response evaluated directly.
 */
/**
 * The second mode of the ring: a multiple of the fundamental, and how much of
 * it to mix in.
 *
 * **Shipped off**, at Ray's dial on 2026-09-13. Turned up it adds a faster mode
 * that dies away sooner, so a blow starts busy and beats against the
 * fundamental before settling — flesh rather than a tuning fork. That reads
 * well on a short, sharp impact ring; it fights the long slow undulation the
 * wobble is currently dialled to, which wants one clean travelling wave.
 *
 * Left in place because it is two numbers and the impact look may come back.
 */
export const RING_HARMONIC = 1;
export const RING_HARMONIC_MIX = 0;

export function ringAt(
  sinceHit: number,
  hz: number,
  decay: number,
  harmonic = RING_HARMONIC,
  mix = RING_HARMONIC_MIX,
) {
  // `sinceHit` is Infinity before the first blow of a session, and the decay
  // alone does not save this: `exp(-Infinity) * sin(Infinity)` is `0 * NaN`,
  // which is NaN. One NaN here becomes a NaN quaternion on every bone in the
  // spine and the skinned mesh collapses to a point — the fish simply is not
  // there any more. Guard the input rather than trusting the envelope.
  if (!Number.isFinite(sinceHit) || sinceHit <= 0) return 0;

  const turn = 2 * Math.PI * sinceHit;
  const first = Math.exp(-decay * sinceHit) * Math.sin(turn * hz);
  // The faster mode dies away sooner, so the wobble starts busy and settles
  // into the slow swing rather than fading evenly.
  const second =
    Math.exp(-decay * 3 * sinceHit) * Math.sin(turn * hz * harmonic);

  // Normalised by the mix, so turning the harmonic up does not also turn the
  // whole wobble up and force the amplitude to be re-dialled every time.
  return (first + mix * second) / (1 + mix);
}

/** Phase of that ring, so the wobble can travel along the body as a wave. */
export function ringPhase(sinceHit: number, hz: number) {
  if (!Number.isFinite(sinceHit) || sinceHit <= 0) return 0;
  // Wrapped, because at a low decay this clock is never reset and a page left
  // open all day would otherwise hand `Math.sin` a number large enough to lose
  // resolution. A sine does not care which turn it is on.
  return (2 * Math.PI * hz * sinceHit) % (2 * Math.PI);
}

/**
 * How the bend is distributed along the body. `u` is 0 at the tail, where the
 * eel is driven, and 1 at the snout, which is free.
 *
 * This is the bending moment of a cantilever under the inertial load of its own
 * mass: the load at distance r from the pivot is proportional to r, and the
 * moment at u is the integral of that load beyond it. Max at the tail, zero at
 * the free end — so the fish curves most where it is held and the snout trails
 * round in a smooth arc, rather than hinging somewhere in the middle.
 *
 * `bias` leans it between the two useful extremes: 1 is the cantilever above,
 * 0 spreads the curvature evenly along the body. Low values give a fish that
 * arcs as one smooth banana; high values keep the bend down by the tail and let
 * the front two thirds stay straighter and whip.
 */
export function bendShape(u: number, bias = 1) {
  const cantilever = 3 * (1 / 3 - u / 2 + (u * u * u) / 6);
  return 1 + (cantilever - 1) * bias;
}

/**
 * How the post-impact ring is distributed. Also tail-weighted, and for the same
 * reason the bend is.
 *
 * The instinct is to put the wobble at the snout, because that is the end with
 * the most room to move. That is true of the *displacement* and false of the
 * *joint angles*, which is what this actually sets. Bone rotations propagate
 * towards the tail and the tail is then pinned back onto the anchor, so a joint
 * near the snout swings almost nothing while a joint near the tail carries the
 * whole body with it. Weighting this towards the snout produces a fish that
 * creases behind its head and barely moves — measured: a rotation at the snout
 * joint displaces the snout by ~0, one at the tail joint by the full length.
 *
 * It agrees with the physics too: the first free mode of a cantilever has its
 * largest deflection at the free end and its largest *curvature* at the fixed
 * one. What makes this read as a ripple rather than a second bend is the phase
 * travelling along the body, not the envelope — so the envelope stays broad.
 *
 * `bias` is how far it leans: 0 is flat along the whole fish, 1 puts nothing at
 * all in the snout. Past about 0.8 the head stops moving and the wobble reads
 * as a crease rather than a ripple.
 */
export function ringShape(u: number, bias = 0.6) {
  return 1 - bias * u;
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
