"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useEffect, useRef } from "react";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import type SSGINode from "three/addons/tsl/display/SSGINode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import {
  diffuseColor,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  sample,
  uniform,
  unpackRGBToNormal,
  vec2,
  vec4,
  velocity,
} from "three/tsl";
import { Vector2 } from "three";
import {
  RenderPipeline,
  UnsignedByteType,
  type PerspectiveCamera,
  type Renderer,
} from "three/webgpu";

/**
 * Screen-space global illumination, as a post-processing pass.
 *
 * Ported from the chalet-template viewer (`packages/viewer/src/renderer/Ssgi.tsx`, r185.1) onto
 * this scene at three r186. The node graph is the same; four things about the host app are not,
 * and each one removed or changed something:
 *
 * - **No `@repo/store`.** The quality tier is a leva dropdown here rather than app state.
 * - **No ground fade.** Chalet has a shadow-catcher plane standing in for endless ground, which
 *   the AO pass would otherwise tint and reveal; it fades AO/GI out by world XZ distance from the
 *   product. This scene's backdrop is a real wall two units behind the head and is *supposed* to
 *   take contact shading, so the fade is gone and the composite runs at full strength everywhere.
 * - **No backdrop probe.** Chalet's canvas is transparent and the page behind it is the sky, so it
 *   reads the DOM background and assigns it to `scene.background` — a `RenderPipeline` composites
 *   to an opaque target and everything at alpha 0 would come out black. `Viewport.tsx` already
 *   attaches an opaque `<color>`, so there is nothing to repair.
 * - **No convergence driving.** Chalet runs `frameloop="demand"` and has to request the frames
 *   SSGI's temporal filter and TRAA need to settle. This canvas runs the default `always` loop, so
 *   the frames arrive anyway. Restore that block if the loop ever goes on demand.
 *
 * **`radius` and `thickness` are world units**, and this is where a straight copy goes wrong:
 * chalet measures in centimetres, this scene in head-heights. Chalet's radius of 6 is 6cm across a
 * ~300cm chalet; here it would be six heads and the march would swallow the frame. The values
 * below are re-scaled to a head of 1 unit — see `SSGI_QUALITY_PRESETS`.
 *
 * **It replaces the normal render.** A `useFrame` priority above 0 disables R3F's own render and
 * this draws through `RenderPipeline.render()` instead. Nothing else may claim a positive priority
 * in the same tree — the scene's other `useFrame` callbacks all sit at the default 0 and still run
 * first, so transforms are up to date by the time this renders.
 *
 * **Three components, for hook reasons.** `SSGIControls` owns the leva panel; `SSGIPipeline`
 * builds the graph and claims the render loop. The split exists because hooks cannot be
 * conditional and the `useFrame` below must not be registered when the effect is off — a claimed
 * render loop with no pipeline behind it draws nothing at all.
 *
 * Four things moved between r181 and r185/r186, so do not copy snippets from older SSGI examples
 * without checking them:
 *
 * - `TraaNode.js` was renamed `TRAANode.js`.
 * - `SSGINode.setup()` returns the AO target rather than a combined vec4, and that target is
 *   `RedFormat` — so `giPass.rgb` yields `(ao, 0, 0)` and paints everything red. Use the accessors.
 * - `directionToColor` / `colorToDirection` became `packNormalToRGB` / `unpackRGBToNormal`.
 * - `PostProcessing` became `RenderPipeline`.
 */
export default function Ssgi() {
  return <SSGIControls />;
}

type SsgiQuality = "low" | "medium" | "high";

type SSGISettings = {
  sliceCount: number;
  stepCount: number;
  radius: number;
  expFactor: number;
  thickness: number;
  backfaceLighting: number;
  aoIntensity: number;
  giIntensity: number;
  giResolutionScale: number;
  useLinearThickness: boolean;
  useScreenSpaceSampling: boolean;
  useTemporalFiltering: boolean;
};

/**
 * `setSize` is public runtime API on `SSGINode` — it sizes the shared AO+GI render target, and the
 * node calls it every frame from `updateBefore` — but it is missing from @types/three (still, at
 * 0.186.0). Re-check on three bumps; if it is ever renamed the wrapper below silently stops
 * scaling anything.
 */
type SSGINodeSized = SSGINode & {
  setSize: (width: number, height: number) => void;
};

/**
 * What each quality tier costs. The march runs `sliceCount x stepCount x 2` depth samples per GI
 * pixel and the pass renders at `giResolutionScale` of the drawing buffer, so cost scales with
 * `sliceCount * stepCount * giResolutionScale^2`.
 *
 * These live here rather than on the leva panel because the panel would be a second source of
 * truth for the same values. Only integer divisors of the drawing buffer are used: a fractional
 * grid beats against the pixel grid and bands across smooth gradients. Nothing drops below half:
 * under that, TRAA's 3x3 variance box is narrower than one march block, history is clipped to the
 * current noisy frame instead of accumulated against it, and the noise stops being filtered out.
 *
 * The radii are chalet's tiers divided through by its scene scale and re-fitted to this one: a
 * head is 1 unit, the eye-to-cheek travel of a slap is about 0.3, and the backdrop stands 2.2
 * behind the face. Under ~0.2 the AO collapses into a crease liner around the nostrils and eye
 * sockets; over ~1.2 the wall starts occluding the whole head and the GI turns into a green wash.
 */
const SSGI_QUALITY_PRESETS: Record<
  SsgiQuality,
  Pick<
    SSGISettings,
    | "sliceCount"
    | "stepCount"
    | "giResolutionScale"
    | "radius"
    | "aoIntensity"
    | "giIntensity"
  >
> = {
  low: {
    sliceCount: 1,
    stepCount: 6,
    radius: 0.35,
    giResolutionScale: 0.5,
    aoIntensity: 2,
    giIntensity: 5,
  },
  medium: {
    sliceCount: 1,
    stepCount: 10,
    radius: 0.6,
    giResolutionScale: 1,
    aoIntensity: 3,
    giIntensity: 10,
  },
  high: {
    sliceCount: 2,
    stepCount: 20,
    radius: 0.8,
    giResolutionScale: 1,
    aoIntensity: 3,
    giIntensity: 10,
  },
};

/**
 * The leva panel, and the on/off switch.
 *
 * `enabled` unmounts `SSGIPipeline` rather than telling it to skip a frame, because the pipeline's
 * `useFrame` priority is what suppresses R3F's own render. Leaving it mounted-but-idle would leave
 * the canvas blank.
 *
 * Switching it off falls back to MSAA: R3F's own render returns, drawing the scene straight into
 * the multisampled canvas. On the SSGI path that canvas MSAA is inert, since the composite is a
 * fullscreen quad with no interior edges to resolve, and TRAA is the antialiasing instead.
 */
function SSGIControls() {
  const { enabled, quality, ...settings } = useControls({
    ssgi: folder(
      {
        enabled: { value: false, label: "ssgi" },
        quality: {
          value: "medium" as SsgiQuality,
          options: ["low", "medium", "high"] as const,
        },
        // World units — see the note on `SSGI_QUALITY_PRESETS`. The quality tier sets this; the
        // slider is here to override it while judging a look.
        thickness: { value: 0.15, min: 0.01, max: 2, step: 0.01 },
        expFactor: { value: 2, min: 1, max: 3, step: 1 },
        backfaceLighting: { value: 0, min: 0, max: 1, step: 1 },
        useLinearThickness: false,
        useScreenSpaceSampling: true,
        useTemporalFiltering: { value: true, label: "traa" },
      },
      { collapsed: true },
    ),
  });

  if (!enabled) return null;

  return (
    <SSGIPipeline
      {...settings}
      {...SSGI_QUALITY_PRESETS[quality as SsgiQuality]}
    />
  );
}

/**
 * Pushes the panel values onto an `SSGINode`.
 *
 * Shared because it has to happen in **two** places: when the graph is (re)built, and when a value
 * changes. Only doing the latter is a real bug — the pipeline is rebuilt whenever the renderer,
 * scene, camera or `useTemporalFiltering` changes, and the rebuild creates a fresh `SSGINode`
 * carrying **three's own defaults** (`stepCount` 12 against a panel value of 6, for instance)
 * while the change-driven effect does not re-run, because none of its dependencies changed.
 */
const applyUniforms = (giPass: SSGINode, settings: SSGISettings) => {
  giPass.sliceCount.value = settings.sliceCount;
  giPass.stepCount.value = settings.stepCount;
  giPass.radius.value = settings.radius;
  giPass.expFactor.value = settings.expFactor;
  giPass.thickness.value = settings.thickness;
  giPass.backfaceLighting.value = settings.backfaceLighting;
  giPass.aoIntensity.value = settings.aoIntensity;
  giPass.giIntensity.value = settings.giIntensity;
  giPass.useLinearThickness.value = settings.useLinearThickness;
  giPass.useScreenSpaceSampling.value = settings.useScreenSpaceSampling;
};

function SSGIPipeline({
  sliceCount,
  stepCount,
  radius,
  expFactor,
  thickness,
  backfaceLighting,
  aoIntensity,
  giIntensity,
  giResolutionScale,
  useLinearThickness,
  useScreenSpaceSampling,
  useTemporalFiltering,
}: SSGISettings) {
  const renderer = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  const pipelineRef = useRef<RenderPipeline | null>(null);
  const giPassRef = useRef<SSGINode | null>(null);

  // Assigned during render, deliberately: the build effect below must see the *current* values
  // without taking them as dependencies, or every slider move would rebuild the whole node graph
  // instead of just writing a uniform.
  const settingsRef = useRef<SSGISettings>({
    sliceCount,
    stepCount,
    radius,
    expFactor,
    thickness,
    backfaceLighting,
    aoIntensity,
    giIntensity,
    giResolutionScale,
    useLinearThickness,
    useScreenSpaceSampling,
    useTemporalFiltering,
  });
  settingsRef.current = {
    sliceCount,
    stepCount,
    radius,
    expFactor,
    thickness,
    backfaceLighting,
    aoIntensity,
    giIntensity,
    giResolutionScale,
    useLinearThickness,
    useScreenSpaceSampling,
    useTemporalFiltering,
  };

  // `useTemporalFiltering` is a plain boolean on SSGINode, not a uniform, and it also decides
  // whether the output runs through TRAA — so it changes the graph and belongs in this effect
  // rather than the uniform pushes below.
  useEffect(() => {
    // **`samples: 0` is required, not a tuning choice.** `PassNode` otherwise inherits
    // `renderer.samples`, and R3F asks for MSAA by default so the no-SSGI path gets antialiased. A
    // multisampled render target carries a multisampled `depthTexture`, and the march below reads
    // that depth as a texture: WebGPU cannot resolve a depth attachment (there is no
    // `resolveTarget` for depth in the spec), so the read degrades to a 4-sample-to-1-sample copy
    // the backend refuses, once per frame, silently. A pass cannot mix sample counts either, so
    // the scene pass stays single-sampled and TRAA is what antialiases this path.
    const scenePass = pass(scene, camera, { samples: 0 });

    scenePass.setMRT(
      mrt({
        output,
        diffuseColor,
        normal: packNormalToRGB(normalView),
        velocity,
      }),
    );

    const scenePassColor = scenePass.getTextureNode("output");
    const scenePassDiffuse = scenePass.getTextureNode("diffuseColor");
    const scenePassDepth = scenePass.getTextureNode("depth");
    const scenePassNormal = scenePass.getTextureNode("normal");
    const scenePassVelocity = scenePass.getTextureNode("velocity");

    // Both are written and read every frame at full resolution and neither needs more than 8 bits
    // per channel — the normal is packed into a colour by `packNormalToRGB`.
    scenePass.getTexture("diffuseColor").type = UnsignedByteType;
    scenePass.getTexture("normal").type = UnsignedByteType;

    const sceneNormal = sample((uv) =>
      unpackRGBToNormal(scenePassNormal.sample(uv)),
    );

    const divisor = Math.max(1, Math.round(1 / giResolutionScale));

    // Give the march depth on **its own grid**.
    //
    // Scaled below 1, a GI texel centre lands on a full-res texel *boundary*, and depth formats
    // cannot be filtered: a plain read returns a neighbour's depth while `SSGINode` reconstructs
    // the shading point from the GI texel's own uv. Position and depth then disagree by (pixel
    // offset x depth gradient) and the surface occludes itself, worst on grazing geometry — here
    // the backdrop wall seen edge-on at the top and bottom of frame.
    //
    // Window-space depth is affine in screen position across a planar surface (no logarithmic
    // depth buffer here), so bilinear interpolation of the surrounding 2x2 is exact for planes and
    // puts the shading point back on the surface. A silhouette blends two surfaces over one texel,
    // which the wall outnumbers here. Only the march reads this; TRAA keeps the real full-res depth.
    const depthSize = uniform(new Vector2(1, 1));
    const marchDepth =
      divisor > 1
        ? sample((uv) => {
            const texel = vec2(1, 1).div(depthSize);
            const coord = uv.mul(depthSize).sub(0.5);
            const base = coord.floor().add(0.5).div(depthSize);
            const weight = coord.fract();
            const d00 = scenePassDepth.sample(base).r;
            const d10 = scenePassDepth.sample(base.add(vec2(texel.x, 0))).r;
            const d01 = scenePassDepth.sample(base.add(vec2(0, texel.y))).r;
            const d11 = scenePassDepth.sample(base.add(texel)).r;
            return vec4(
              mix(mix(d00, d10, weight.x), mix(d01, d11, weight.x), weight.y),
            );
          })
        : scenePassDepth;

    const giPass = ssgi(
      scenePassColor,
      marchDepth,
      sceneNormal,
      camera as PerspectiveCamera,
    );
    giPass.useTemporalFiltering = useTemporalFiltering;
    applyUniforms(giPass, settingsRef.current);
    giPassRef.current = giPass;

    // The march is per GI pixel — `sliceCount x stepCount x 2` depth samples each — so rendering
    // AO+GI at an integer fraction of the drawing buffer divides the dominant GPU cost by
    // `divisor^2`. The scene, the composite and TRAA all stay full resolution; only this pass
    // shrinks, and the composite's texture reads scale it back up. `SSGINode` re-calls `setSize`
    // from `updateBefore` every frame with the full drawing-buffer size, which is where the
    // division hooks in; divisor 1 leaves the node untouched, bit-identical to no wrapper at all.
    if (divisor > 1) {
      const sizedGiPass = giPass as SSGINodeSized;
      const nodeSetSize = sizedGiPass.setSize.bind(sizedGiPass);
      sizedGiPass.setSize = (width, height) => {
        // `width`/`height` are the full drawing buffer — the size of the depth buffer the
        // prefilter above gathers from.
        depthSize.value.set(width, height);
        nodeSetSize(
          Math.max(1, Math.round(width / divisor)),
          Math.max(1, Math.round(height / divisor)),
        );
      };
    }

    // **Read AO and GI through the accessors, never off `giPass` itself.**
    //
    // `SSGINode.setup()` returns `this._aoNode` — the ambient-occlusion target alone, and that
    // target is `RedFormat`. So using the node directly gives a single channel: `giPass.rgb` is
    // `(ao, 0, 0)` and `giPass.a` is meaningless. Multiplied by `giIntensity` that paints the
    // whole scene red. The GI result is only reachable via `getGINode()`.
    const ao = giPass.getAONode().r;
    const gi = giPass.getGINode().rgb;

    // AO attenuates the lit result; GI is added on top of the albedo, which is why the diffuse
    // buffer is in the MRT at all. Chalet fades both out with world distance to hide its
    // shadow-catcher plane; this scene's backdrop is real geometry and keeps the full effect.
    const composite = vec4(
      scenePassColor.rgb.mul(ao).add(scenePassDiffuse.rgb.mul(gi)),
      scenePassColor.a,
    );
    composite.name = "SSGI Composite";

    // R3F types `gl` as WebGLRenderer even though `Viewport.tsx` hands it a WebGPURenderer.
    const pipeline = new RenderPipeline(renderer as unknown as Renderer);

    pipeline.outputNode = useTemporalFiltering
      ? traa(composite, scenePassDepth, scenePassVelocity, camera)
      : composite;
    pipeline.needsUpdate = true;

    pipelineRef.current = pipeline;

    return () => {
      pipelineRef.current = null;
      giPassRef.current = null;
      pipeline.dispose();
    };
  }, [renderer, scene, camera, useTemporalFiltering, giResolutionScale]);

  // Later changes only need the uniform write, not a rebuild.
  useEffect(() => {
    if (giPassRef.current)
      applyUniforms(giPassRef.current, settingsRef.current);
  }, [
    sliceCount,
    stepCount,
    radius,
    expFactor,
    thickness,
    backfaceLighting,
    aoIntensity,
    giIntensity,
    giResolutionScale,
    useLinearThickness,
    useScreenSpaceSampling,
  ]);

  // Priority > 0 hands rendering over: R3F skips its own render and this draws the pipeline.
  // Every other `useFrame` in the scene is at the default 0, so the slap timeline, the jelly
  // uniforms and the eel transforms are all written before this runs.
  //
  // Chalet additionally drives extra frames here, because it renders on demand and TRAA needs a
  // Halton cycle to settle. This canvas runs the default continuous loop, so the frames arrive on
  // their own — restore that block if it ever goes on demand.
  useFrame(() => {
    pipelineRef.current?.render();
  }, 1);

  return null;
}
