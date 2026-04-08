import { initWebGPU, createPipeline } from './src/renderer';
import { initCamera, initOrbitalControls, mat4Perspective, mat4LookAt } from './src/camera';
import { load_mesh, _mat4Multiply } from './src/mesh';

async function loadTexture(device: GPUDevice, url: string): Promise<GPUTexture> {
  let imageBitmap: ImageBitmap;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('not found');
    imageBitmap = await createImageBitmap(await res.blob());
  } catch {
    // fallback: 1×1 white pixel
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 1, 1);
    imageBitmap = await createImageBitmap(canvas);
  }
  const texture = device.createTexture({
    size: [imageBitmap.width, imageBitmap.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
  });
  device.queue.copyExternalImageToTexture({ source: imageBitmap }, { texture }, [imageBitmap.width, imageBitmap.height]);
  return texture;
}

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

  const uvBuffer = device.createBuffer({
    size: mesh.uvs.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uvBuffer, 0, mesh.uvs);

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

  const [rasterCode, uvViewCode, uvIdCode, texture] = await Promise.all([
    fetch('shaders/raster.wgsl').then(r => r.text()),
    fetch('shaders/uv_view.wgsl').then(r => r.text()),
    fetch('shaders/uv_id.wgsl').then(r => r.text()),
    loadTexture(device, 'assets/texture.png'),
  ]);

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

  // --- 3D pipeline ---
  const pipeline = createPipeline(device, format, rasterCode, [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    { arrayStride: 8,  attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
  ]);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: sampler },
    ],
  });

  // --- UV-ID offscreen pass ---
  // rgba32float gives full float32 UV precision (no quantization at any texture size).
  // It's core WebGPU for render attachment but log clearly if the device rejects it.
  let uvIdTexture: GPUTexture;
  let uvIdPipeline: GPURenderPipeline;
  try {
    uvIdTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'rgba32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    uvIdPipeline = createPipeline(device, 'rgba32float', uvIdCode, [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 8,  attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
    ]);
  } catch (e) {
    console.error('rgba32float render attachment not supported on this device — UV click will not work.', e);
    throw e;
  }

  const uvIdDepth = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const uvIdTextureView = uvIdTexture.createView();
  const uvIdDepthView   = uvIdDepth.createView();

  const uvIdBindGroup = device.createBindGroup({
    layout: uvIdPipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // Staging buffer for 1-pixel readback (bytesPerRow must be multiple of 256)
  const stagingBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  function handleUVClick(uvX: number, uvY: number) {
    console.log(`UV at click: (${uvX.toFixed(3)}, ${uvY.toFixed(3)})`);
  }

  let readbackInFlight = false;
  canvas.addEventListener('click', async (e) => {
    if (readbackInFlight) return;
    readbackInFlight = true;

    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(e.clientX - rect.left);
    const y = Math.floor(e.clientY - rect.top);

    const copyEncoder = device.createCommandEncoder();
    copyEncoder.copyTextureToBuffer(
      { texture: uvIdTexture, origin: { x, y, z: 0 } },
      { buffer: stagingBuffer, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
    device.queue.submit([copyEncoder.finish()]);

    try {
      await stagingBuffer.mapAsync(GPUMapMode.READ);
      const px = new Float32Array(stagingBuffer.getMappedRange(0, 16)); // rgba32float = 4×4 bytes
      const hit = px[3] > 0;
      const uvX = hit ? px[0] : -1;
      const uvY = hit ? px[1] : -1;
      stagingBuffer.unmap();
      if (hit) handleUVClick(uvX, uvY);
      else console.log('no hit');
    } catch (e) {
      console.error('UV readback failed', e);
    } finally {
      readbackInFlight = false;
    }
  });

  // --- UV canvas pipeline ---
  const uvCanvas = document.getElementById('uv-canvas') as HTMLCanvasElement;
  uvCanvas.width  = mainPanel.clientWidth;
  uvCanvas.height = mainPanel.clientHeight;

  const uvContext = uvCanvas.getContext('webgpu')!;
  uvContext.configure({ device, format, alphaMode: 'opaque' });

  // The canvas is mainPanel-sized but only the center half in Y is visible
  // (same trick as the 3D canvas). Visible area = full width × half height.
  // UV square must appear square: scaleX * W == scaleY * H (px).
  // Fit 90% of the smaller visible dimension (W vs H/2).
  const uvVisibleAspect = uvCanvas.width / (uvCanvas.height / 2); // W / (H/2)
  const uvState = uvVisibleAspect >= 1
    ? { scaleX: 0.45 * uvCanvas.height / uvCanvas.width, scaleY: 0.45, offX: 0, offY: 0 }
    : { scaleX: 0.9,  scaleY: 0.9 * uvCanvas.width / uvCanvas.height, offX: 0, offY: 0 };

  const uvTransformBuffer = device.createBuffer({
    size: 16, // vec2 scale + vec2 offset
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // UV view: only UV buffer as vertex input (location 0), no depth
  const uvPipeline = createPipeline(device, format, uvViewCode, [
    { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
  ], false, 'none');

  const uvBindGroup = device.createBindGroup({
    layout: uvPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uvTransformBuffer } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: sampler },
    ],
  });

  // Pan: drag on UV canvas
  let uvDragging = false;
  let uvDragMoved = false;
  let uvLastMouse = { x: 0, y: 0 };
  uvCanvas.addEventListener('mousedown', (e) => {
    uvDragging = true;
    uvDragMoved = false;
    uvLastMouse = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!uvDragging) return;
    uvDragMoved = true;
    uvState.offX += (e.clientX - uvLastMouse.x) / uvCanvas.width  *  2;
    uvState.offY += (e.clientY - uvLastMouse.y) / uvCanvas.height * -2; // Y flipped
    uvLastMouse = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mouseup', () => { uvDragging = false; });

  // Zoom: scroll on UV canvas, centered on cursor
  uvCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = uvCanvas.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / uvCanvas.width)  *  2 - 1;
    const cy = 1 - ((e.clientY - rect.top)  / uvCanvas.height) *  2;
    // Keep the point under the cursor fixed: newOffset = cx*(1-factor) + offset*factor
    uvState.offX = cx * (1 - factor) + uvState.offX * factor;
    uvState.offY = cy * (1 - factor) + uvState.offY * factor;
    uvState.scaleX *= factor;
    uvState.scaleY *= factor;
  }, { passive: false });

  uvCanvas.addEventListener('click', (e) => {
    if (uvDragMoved) return;
    const rect = uvCanvas.getBoundingClientRect();
    // Canvas-space click → clip coords [-1, 1]
    const clipX = ((e.clientX - rect.left) / uvCanvas.width)  *  2 - 1;
    const clipY = 1 - ((e.clientY - rect.top)  / uvCanvas.height) *  2;
    // Invert the UV→clip transform from uv_view.wgsl:
    //   clip = (uv*2-1, 1-uv*2) * scale + offset
    const uvX = ((clipX - uvState.offX) / uvState.scaleX + 1) / 2;
    const uvY = (1 - (clipY - uvState.offY) / uvState.scaleY) / 2;
    if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1) { console.log('no hit'); return; }
    handleUVClick(uvX, uvY);
  });

  function frame() {
    const view = mat4LookAt(camera.position, camera.target, camera.up);
    const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
    const mvp  = _mat4Multiply(proj, view);
    device.queue.writeBuffer(uniformBuffer, 0, mvp);

    const encoder = device.createCommandEncoder();

    // UV-ID pass (offscreen, used for click → UV lookup)
    const passId = encoder.beginRenderPass({
      colorAttachments: [{
        view: uvIdTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp:  'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: uvIdDepthView,
        depthClearValue: 1.0,
        depthLoadOp:  'clear',
        depthStoreOp: 'store',
      },
    });
    passId.setPipeline(uvIdPipeline);
    passId.setBindGroup(0, uvIdBindGroup);
    passId.setVertexBuffer(0, vertexBuffer);
    passId.setVertexBuffer(1, uvBuffer);
    passId.setIndexBuffer(indexBuffer, 'uint32');
    passId.drawIndexed(mesh.indices.length);
    passId.end();

    // 3D pass
    const pass3D = encoder.beginRenderPass({
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
    pass3D.setPipeline(pipeline);
    pass3D.setBindGroup(0, bindGroup);
    pass3D.setVertexBuffer(0, vertexBuffer);
    pass3D.setVertexBuffer(1, uvBuffer);
    pass3D.setIndexBuffer(indexBuffer, 'uint32');
    pass3D.drawIndexed(mesh.indices.length);
    pass3D.end();

    // Write UV transform
    device.queue.writeBuffer(uvTransformBuffer, 0,
      new Float32Array([uvState.scaleX, uvState.scaleY, uvState.offX, uvState.offY]));

    // UV pass
    const passUV = encoder.beginRenderPass({
      colorAttachments: [{
        view: uvContext.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
        loadOp:  'clear',
        storeOp: 'store',
      }],
    });
    passUV.setPipeline(uvPipeline);
    passUV.setBindGroup(0, uvBindGroup);
    passUV.setVertexBuffer(0, uvBuffer);
    passUV.setIndexBuffer(indexBuffer, 'uint32');
    passUV.drawIndexed(mesh.indices.length);
    passUV.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);
