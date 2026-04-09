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
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
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
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Brush: vec2 uv, f32 radius, f32 on, f32 painting, f32 matId, f32 _pad0, f32 _pad1 = 32 bytes
  const brushBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const brushState = { uvX: 0, uvY: 0, radius: 0.05, on: 0, painting: 0, matId: 1 }; // matId is f32 in the buffer — shader casts to u32, fine for small integers

  // Materials: array<Material, 16> where Material = { baseColor: vec3f, roughness: f32 } = 16 bytes each
  // Material 0 is reserved — matId 0 means "show base texture"
  // Material 1+: user-defined paint materials
  const materialsData = new Float32Array(16 * 4);
  materialsData.set([0.2, 0.5, 1.0, 0.5], 1 * 4); // material 1: blue
  materialsData.set([1.0, 0.2, 0.2, 0.5], 2 * 4); // material 2: red
  const materialsBuf = device.createBuffer({
    size: materialsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(materialsBuf, 0, materialsData);

  const depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const [rasterCode, uvViewCode, uvIdCode, paintCode, texture] = await Promise.all([
    fetch('shaders/raster.wgsl').then(r => r.text()),
    fetch('shaders/uv_view.wgsl').then(r => r.text()),
    fetch('shaders/uv_id.wgsl').then(r => r.text()),
    fetch('shaders/paint.wgsl').then(r => r.text()),
    loadTexture(device, 'assets/texture.png'),
  ]);

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

  // Paint texture: r32uint, one material ID per texel, 0 = base texture — matches base texture resolution
  const paintTex = device.createTexture({
    size: [texture.width, texture.height],
    format: 'r32uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Initialize to 0 (all texels show base texture)
  device.queue.writeTexture(
    { texture: paintTex },
    new Uint32Array(texture.width * texture.height),
    { bytesPerRow: texture.width * 4 },
    [texture.width, texture.height],
  );

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
      { binding: 3, resource: { buffer: brushBuffer } },
      { binding: 4, resource: paintTex.createView() },
      { binding: 5, resource: { buffer: materialsBuf } },
    ],
  });

  // --- UV-ID offscreen pass ---
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
    console.error('rgba32float render attachment not supported — UV click will not work.', e);
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

  const stagingBuffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  let readbackInFlight = false;

  async function readUVAtPixel(x: number, y: number): Promise<{ hit: boolean; uvX: number; uvY: number }> {
    const copyEncoder = device.createCommandEncoder();
    copyEncoder.copyTextureToBuffer(
      { texture: uvIdTexture, origin: { x, y, z: 0 } },
      { buffer: stagingBuffer, bytesPerRow: 256 },
      { width: 1, height: 1 },
    );
    device.queue.submit([copyEncoder.finish()]);
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const px = new Float32Array(stagingBuffer.getMappedRange(0, 16));
    const hit = px[3] > 0;
    const uvX = hit ? px[0] : -1;
    const uvY = hit ? px[1] : -1;
    stagingBuffer.unmap();
    return { hit, uvX, uvY };
  }

  // --- Paint compute pipeline ---
  const paintPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: paintCode }), entryPoint: 'main' },
  });

  const paintBindGroup = device.createBindGroup({
    layout: paintPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: brushBuffer } },
      { binding: 1, resource: paintTex.createView() },
    ],
  });

  function dispatchPaint() {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(paintPipeline);
    pass.setBindGroup(0, paintBindGroup);
    pass.dispatchWorkgroups(Math.ceil(paintTex.width / 8), Math.ceil(paintTex.height / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function inViewport(el: Element, e: MouseEvent) {
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  // --- Input ---
  const objViewport = document.getElementById('object-viewport')!;
  const uvViewport  = document.getElementById('uv-viewport')!;
  let uvDragging = false;
  let uvDragIsPan = false;
  let uvLastMouse = { x: 0, y: 0 };
  let isPainting = false;

  canvas.addEventListener('mousedown', (e) => {
    if (!inViewport(objViewport, e)) return;
    if (e.button !== 0 || e.altKey || e.shiftKey) return; // alt+drag = orbit, shift+drag = pan (both handled by camera)
    isPainting = true;
    brushState.painting = 1;
    if (brushState.on) dispatchPaint();
  });

  canvas.addEventListener('mousemove', async (e) => {
    if (!inViewport(objViewport, e)) return;
    if (readbackInFlight) return;
    readbackInFlight = true;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(e.clientX - rect.left);
    const y = Math.floor(e.clientY - rect.top);
    try {
      const { hit, uvX, uvY } = await readUVAtPixel(x, y);
      brushState.on = hit ? 1 : 0;
      if (hit) {
        brushState.uvX = uvX;
        brushState.uvY = uvY;
        if (isPainting) dispatchPaint();
      }
    } catch {
      // silently ignore readback errors during hover
    } finally {
      readbackInFlight = false;
    }
  });

  canvas.addEventListener('mouseleave', () => { brushState.on = 0; });

  window.addEventListener('mouseup', () => {
    isPainting = false;
    brushState.painting = 0;
    uvDragging = false;
    uvDragIsPan = false;
  });

  // --- UV canvas ---
  const uvCanvas = document.getElementById('uv-canvas') as HTMLCanvasElement;
  uvCanvas.width  = mainPanel.clientWidth;
  uvCanvas.height = mainPanel.clientHeight;

  const uvContext = uvCanvas.getContext('webgpu')!;
  uvContext.configure({ device, format, alphaMode: 'opaque' });

  const uvVisibleAspect = uvCanvas.width / (uvCanvas.height / 2);
  const uvState = uvVisibleAspect >= 1
    ? { scaleX: 0.45 * uvCanvas.height / uvCanvas.width, scaleY: 0.45, offX: 0, offY: 0 }
    : { scaleX: 0.9,  scaleY: 0.9 * uvCanvas.width / uvCanvas.height, offX: 0, offY: 0 };

  const uvTransformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const uvPipeline = createPipeline(device, format, uvViewCode, [
    { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
  ], false, 'none');

  const uvBindGroup = device.createBindGroup({
    layout: uvPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uvTransformBuffer } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: brushBuffer } },
      { binding: 4, resource: paintTex.createView() },
      { binding: 5, resource: { buffer: materialsBuf } },
    ],
  });

  uvCanvas.addEventListener('mousedown', (e) => {
    if (!inViewport(uvViewport, e)) return;
    if (e.button !== 0) return;
    uvDragging = true;
    uvDragIsPan = e.altKey || e.shiftKey || e.ctrlKey; // alt/shift/ctrl+drag = pan, plain drag = paint
    uvLastMouse = { x: e.clientX, y: e.clientY };
    if (!uvDragIsPan) {
      isPainting = true;
      brushState.painting = 1;
      if (brushState.on) dispatchPaint();
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!uvDragging || !uvDragIsPan) return;
    uvState.offX += (e.clientX - uvLastMouse.x) / uvCanvas.width  *  2;
    uvState.offY += (e.clientY - uvLastMouse.y) / uvCanvas.height * -2;
    uvLastMouse = { x: e.clientX, y: e.clientY };
  });

  uvCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const rect = uvCanvas.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / uvCanvas.width)  *  2 - 1;
    const cy = 1 - ((e.clientY - rect.top)  / uvCanvas.height) *  2;
    uvState.offX = cx * (1 - factor) + uvState.offX * factor;
    uvState.offY = cy * (1 - factor) + uvState.offY * factor;
    uvState.scaleX *= factor;
    uvState.scaleY *= factor;
  }, { passive: false });

  uvCanvas.addEventListener('mousemove', (e) => {
    if (!inViewport(uvViewport, e)) return;
    const rect = uvCanvas.getBoundingClientRect();
    const clipX = ((e.clientX - rect.left) / uvCanvas.width)  *  2 - 1;
    const clipY = 1 - ((e.clientY - rect.top)  / uvCanvas.height) *  2;
    const uvX = ((clipX - uvState.offX) / uvState.scaleX + 1) / 2;
    const uvY = (1 - (clipY - uvState.offY) / uvState.scaleY) / 2;
    const hit = uvX >= 0 && uvX <= 1 && uvY >= 0 && uvY <= 1;
    brushState.on = hit ? 1 : 0;
    if (hit) {
      brushState.uvX = uvX;
      brushState.uvY = uvY;
      if (isPainting) dispatchPaint();
    }
  });

  uvCanvas.addEventListener('mouseleave', () => { brushState.on = 0; });

  // --- Frame loop ---
  function frame() {
    const view = mat4LookAt(camera.position, camera.target, camera.up);
    const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
    const mvp  = _mat4Multiply(proj, view);
    device.queue.writeBuffer(uniformBuffer, 0, mvp);

    device.queue.writeBuffer(brushBuffer, 0, new Float32Array([
      brushState.uvX, brushState.uvY, brushState.radius, brushState.on,
      brushState.painting, brushState.matId, 0, 0,
    ]));

    device.queue.writeBuffer(uvTransformBuffer, 0,
      new Float32Array([uvState.scaleX, uvState.scaleY, uvState.offX, uvState.offY]));

    const encoder = device.createCommandEncoder();

    // UV-ID pass
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
