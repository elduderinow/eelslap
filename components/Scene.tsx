"use client";

import dynamic from "next/dynamic";

const Viewport = dynamic(() => import("./Viewport"), {
  ssr: false,
  loading: () => <div className="fallback">Starting WebGPU&hellip;</div>,
});

export default function Scene() {
  return <Viewport />;
}
