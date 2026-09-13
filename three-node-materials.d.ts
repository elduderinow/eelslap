import type { ThreeElement } from "@react-three/fiber";
import type {
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";

// `extend(THREE)` in Viewport.tsx registers the whole WebGPU build at runtime.
// TypeScript needs to be told separately about the elements we actually use.
declare module "@react-three/fiber" {
  interface ThreeElements {
    meshBasicNodeMaterial: ThreeElement<typeof MeshBasicNodeMaterial>;
    meshPhysicalNodeMaterial: ThreeElement<typeof MeshPhysicalNodeMaterial>;
    meshStandardNodeMaterial: ThreeElement<typeof MeshStandardNodeMaterial>;
  }
}
