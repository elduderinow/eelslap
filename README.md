# eelslap

A WebGPU homage to [eelslap.com](https://eelslap.com), built with three.js
(`three/webgpu`), react-three-fiber and Next.js.

A scanned head takes the blow. The flesh wobble is a compute shader over the
mesh's vertices, so it needs a real WebGPU backend; without one the app falls
back to WebGL2 and only the rigid neck bend runs. The eel is a rigged lamprey
GLB, held in its bind pose and laid along the camera -> face vector, so it is
seen end-on and reads as coming at the viewer.

Move the mouse left and right to swing.

## Running

```bash
npm install
npm run dev
```

## Deploying

Push to `master`. Vercel is connected to this repository and builds from it.
Do not deploy from the working tree with `vercel deploy`.
