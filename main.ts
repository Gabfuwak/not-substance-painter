import { initWebGPU, createPipeline } from './src/renderer';
import { initCamera, initOrbitalControls, mat4Perspective, mat4LookAt } from './src/camera';
import { load_mesh, _mat4Multiply } from './src/mesh';

async function main() {
  const canvas    = document.getElementById('object-canvas') as HTMLCanvasElement;
  const mainPanel = document.getElementById('main-panel')!;
  canvas.width  = mainPanel.clientWidth;
  canvas.height = mainPanel.clientHeight;

  const { device, context, format } = await initWebGPU(canvas);

  const camera  = initCamera(canvas);
  camera.aspect = canvas.width / canvas.height;
  camera.position = [3, 2, 3];
  camera.target   = [0, 0, 0];
  camera.near     = 0.1;
  camera.far      = 100;

  initOrbitalControls(canvas, camera);

  const objText = await fetch('assets/cube.obj').then(r => r.text());
  const mesh = load_mesh(objText);

  const vertexBuffer = device.createBuffer({
    size: mesh.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, mesh.positions);

  const indexBuffer = device.createBuffer({
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, mesh.indices);

  const uniformBuffer = device.createBuffer({
    size: 64, // mat4x4f = 16 floats * 4 bytes
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const shaderCode = await fetch('shaders/raster.wgsl').then(r => r.text());
  const pipeline = createPipeline(device, format, shaderCode, [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  ]);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  function frame() {
    const view = mat4LookAt(camera.position, camera.target, camera.up);
    const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
    const mvp  = _mat4Multiply(proj, view);
    device.queue.writeBuffer(uniformBuffer, 0, mvp);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.15, g: 0.15, b: 0.15, a: 1 },
        loadOp:  'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp:  'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(mesh.indices.length);
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);
