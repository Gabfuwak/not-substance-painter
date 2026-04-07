// === renderer.ts ===
// WebGPU device + rasterizer pipeline

export async function initWebGPU(canvas: HTMLCanvasElement) {
  if (!navigator.gpu) throw new Error("WebGPU not supported");

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter found");

  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  return { device, context, format };
}

export function createPipeline(device: GPUDevice, format: GPUTextureFormat, shaderCode: string, buffers: GPUVertexBufferLayout[] = []) {
  const module = device.createShaderModule({ code: shaderCode });
  return device.createRenderPipeline({
    layout: "auto",
    vertex:   { module, entryPoint: "vs", buffers },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    primitive: { topology: "triangle-list", cullMode: "back" },
  });
}
