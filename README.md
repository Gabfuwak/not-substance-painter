# 3D Painter

A browser-based PBR texture painting tool built with TypeScript and WebGPU.

## Running the project

```bash
npm install
npm run build
```

Then open `index.html` in a WebGPU-compatible browser (Chrome 113+ or Edge 113+).

## Features

- Paint directly on a 3D mesh across three PBR channels: Base Color, Normal, Roughness
- Dual viewport: 3D view and UV view update simultaneously in real time
- Two shading modes: Solid and Rendered (GGX PBR)
- Tools: Select, Move, Orbit, Brush — switchable from the left toolbar or right-click pie menu
- Brush options: color, size, strength
- Per-channel undo (Ctrl+Z, up to 20 steps)
- Load any OBJ model, load/save individual channel textures as PNG

## Controls

| Action | Input |
|---|---|
| Orbit | Orbit tool + drag, or Alt + drag |
| Pan | Move tool + drag, or Shift + drag |
| Brush size | Ctrl + scroll |
| Tool switcher | Right-click |
| Undo | Ctrl+Z |

## Structure

```
main.ts          — entry point, GPU setup, render loop, input handling
src/camera.ts    — camera and orbital controls
src/mesh.ts      — OBJ parser and mesh upload
src/renderer.ts  — WebGPU pipeline creation
shaders/         — WGSL shaders (raster, paint, merge, uv_id, uv_view)
```
