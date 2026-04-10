import { initWebGPU, createPipeline } from './src/renderer';
import { initCamera, initOrbitalControls, mat4Perspective, mat4LookAt } from './src/camera';
import { load_mesh, _mat4Multiply } from './src/mesh';


function imageToPackedR32(imageBitmap: ImageBitmap): { data: Uint32Array, width: number, height: number } {
  const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(imageBitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, imageBitmap.width, imageBitmap.height).data;
  const packed = new Uint32Array(imageBitmap.width * imageBitmap.height);
  for (let i = 0; i < packed.length; i++) {
    packed[i] = pixels[i*4] | (pixels[i*4+1] << 8) | (pixels[i*4+2] << 16) | (255 << 24);
  }
  return { data: packed, width: imageBitmap.width, height: imageBitmap.height };
}

async function main() {
  const canvas    = document.getElementById('object-canvas') as HTMLCanvasElement;
  const mainPanel = document.getElementById('main-panel')!;
  const openModelButton = document.getElementById('open-model-button') as HTMLButtonElement | null;
  const openModelInput = document.getElementById('open-model-input') as HTMLInputElement | null;
  const openChannelInput = document.getElementById('open-channel-input') as HTMLInputElement | null;
  canvas.width  = mainPanel.clientWidth;
  canvas.height = mainPanel.clientHeight;

  const { device, context, format } = await initWebGPU(canvas);

  const camera  = initCamera(canvas);
  camera.aspect = canvas.width / canvas.height;
  camera.position = [3, 2, 3];
  camera.target   = [0, 0, 0];
  camera.near     = 0.1;
  camera.far      = 100;

  initOrbitalControls(canvas, camera, () => {
    if (selectedTool === 'orbit') return 'orbit';
    if (selectedTool === 'move')  return 'pan';
    return null;
  });

  let mesh = load_mesh(await fetch('assets/bunny.obj').then(r => r.text()));
  let vertexBuffer: GPUBuffer;
  let uvBuffer: GPUBuffer;
  let normalsBuffer: GPUBuffer;
  let indexBuffer: GPUBuffer;

  function uploadMesh(nextMesh: ReturnType<typeof load_mesh>) {
    vertexBuffer?.destroy();
    uvBuffer?.destroy();
    normalsBuffer?.destroy();
    indexBuffer?.destroy();

    mesh = nextMesh;
    vertexBuffer = device.createBuffer({
      size: mesh.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, mesh.positions);

    uvBuffer = device.createBuffer({
      size: mesh.uvs.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uvBuffer, 0, mesh.uvs);

    normalsBuffer = device.createBuffer({
      size: mesh.normals.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(normalsBuffer, 0, mesh.normals);

    indexBuffer = device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, mesh.indices);
  }

  uploadMesh(mesh);

  async function openObjFile(file: File) {
    const objText = await file.text();
    const nextMesh = load_mesh(objText);
    if (nextMesh.indices.length === 0) {
      throw new Error('Selected OBJ has no faces to render.');
    }
    uploadMesh(nextMesh);
  }

  async function openTextureFile(file: File) {
    const { data, width, height } = imageToPackedR32(await createImageBitmap(file));
    refreshSurfaceResources(data, width, height);
  }

  const uniformBuffer = device.createBuffer({
    size: 96,  // mat4(64) + camera_pos(12) + shading_mode(4) + channel_mode(4) + pad(12)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Brush: vec2 uv(8) + radius(4) + on(4) + painting(4) + r(4) + g(4) + b(4) + strength(4) = 36, padded to 40
  const brushBuffer = device.createBuffer({
    size: 40,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const brushState = { uvX: 0, uvY: 0, radius: 0.05, on: 0, painting: 0, r: 0.8, g: 0.3, b: 0.1 };


  const depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const [commonCode, rasterCode, uvViewCode, uvIdCode, paintCode, mergeCode, initialBitmap, normalBitmap, roughnessBitmap] = await Promise.all([
    fetch('shaders/common.wgsl').then(r => r.text()),
    fetch('shaders/raster.wgsl').then(r => r.text()),
    fetch('shaders/uv_view.wgsl').then(r => r.text()),
    fetch('shaders/uv_id.wgsl').then(r => r.text()),
    fetch('shaders/paint.wgsl').then(r => r.text()),
    fetch('shaders/merge.wgsl').then(r => r.text()),
    fetch('assets/bunny_textures/albedo.jpeg').then(r => r.blob()).then(b => createImageBitmap(b)),
    fetch('assets/bunny_textures/normal.png').then(r => r.blob()).then(b => createImageBitmap(b)),
    fetch('assets/bunny_textures/roughness.jpeg').then(r => r.blob()).then(b => createImageBitmap(b)),
  ]);

  const { data: initialPacked, width: texW, height: texH } = imageToPackedR32(initialBitmap);
  const { data: normalPacked, width: normalTexW, height: normalTexH } = imageToPackedR32(normalBitmap);
  const { data: roughnessPacked, width: roughnessTexW, height: roughnessTexH } = imageToPackedR32(roughnessBitmap);
  let paintTex: GPUTexture;
  let strokeTex: GPUTexture;  // shared across all channels
  let normalPaintTex: GPUTexture;
  let roughnessPaintTex: GPUTexture;


  // --- 3D pipeline ---
  const pipeline = createPipeline(device, format, commonCode + rasterCode, [
    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    { arrayStride: 8,  attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
    { arrayStride: 12, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }] },
  ]);

  let bindGroup: GPUBindGroup;

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
  const depthView       = depthTexture.createView();

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

  // --- Paint compute pipeline (writes to strokeTex) ---
  const paintPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: paintCode }), entryPoint: 'main' },
  });

  let paintBindGroup: GPUBindGroup;  // shared: all channels use brush+strokeTex

  // --- Merge compute pipeline (strokeTex → paintTex, then clears strokeTex) ---
  const mergePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: mergeCode }), entryPoint: 'main' },
  });

  let mergeBindGroup: GPUBindGroup;
  let normalMergeBindGroup: GPUBindGroup;
  let roughnessMergeBindGroup: GPUBindGroup;


  function dispatchMerge() {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(mergePipeline);
    const bg = selectedChannel === 'normal'     ? normalMergeBindGroup
             : selectedChannel === 'roughness'  ? roughnessMergeBindGroup
             : mergeBindGroup;
    const tex = selectedChannel === 'normal'    ? normalPaintTex
              : selectedChannel === 'roughness' ? roughnessPaintTex
              : paintTex;
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(tex.width / 8), Math.ceil(tex.height / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function dispatchPaint() {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(paintPipeline);
    pass.setBindGroup(0, paintBindGroup);  // same bind group for all channels
    pass.dispatchWorkgroups(Math.ceil(strokeTex.width / 8), Math.ceil(strokeTex.height / 8));
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
    if (selectedTool !== 'brush') return;
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

  document.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      changeBrushSize(e.deltaY < 0 ? 0.05 : -0.05);
    } else if (inViewport(uvViewport, e as unknown as MouseEvent)) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const rect = uvCanvas.getBoundingClientRect();
      const cx = ((e.clientX - rect.left) / uvCanvas.width)  *  2 - 1;
      const cy = 1 - ((e.clientY - rect.top)  / uvCanvas.height) *  2;
      uvState.offX = cx * (1 - factor) + uvState.offX * factor;
      uvState.offY = cy * (1 - factor) + uvState.offY * factor;
      uvState.scaleX *= factor;
      uvState.scaleY *= factor;
    }
  }, { passive: false });

  window.addEventListener('mouseup', () => {
    if (isPainting) dispatchMerge();
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
    size: 32,  // scale(8) + offset(8) + channel_mode(4) + pad(12)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const uvPipeline = createPipeline(device, format, commonCode + uvViewCode, [
    { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
  ], false, 'none');

  let uvBindGroup: GPUBindGroup;

  function rebuildBindGroups() {
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 3, resource: { buffer: brushBuffer } },
        { binding: 4, resource: paintTex.createView() },
        { binding: 5, resource: normalPaintTex.createView() },
        { binding: 6, resource: strokeTex.createView() },
        { binding: 7, resource: roughnessPaintTex.createView() },
      ],
    });

    // All channels share a single paint bind group (brush + strokeTex)
    paintBindGroup = device.createBindGroup({
      layout: paintPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: brushBuffer } },
        { binding: 1, resource: strokeTex.createView() },
      ],
    });

    mergeBindGroup = device.createBindGroup({
      layout: mergePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: paintTex.createView() },
        { binding: 1, resource: strokeTex.createView() },
      ],
    });
    normalMergeBindGroup = device.createBindGroup({
      layout: mergePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: normalPaintTex.createView() },
        { binding: 1, resource: strokeTex.createView() },
      ],
    });
    roughnessMergeBindGroup = device.createBindGroup({
      layout: mergePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: roughnessPaintTex.createView() },
        { binding: 1, resource: strokeTex.createView() },
      ],
    });

    uvBindGroup = device.createBindGroup({
      layout: uvPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uvTransformBuffer } },
        { binding: 3, resource: { buffer: brushBuffer } },
        { binding: 4, resource: paintTex.createView() },
        { binding: 5, resource: normalPaintTex.createView() },
        { binding: 6, resource: strokeTex.createView() },
        { binding: 7, resource: roughnessPaintTex.createView() },
      ],
    });
  }

  function refreshSurfaceResources(packedData: Uint32Array, width: number, height: number) {
    paintTex?.destroy();
    strokeTex?.destroy();

    paintTex = device.createTexture({
      size: [width, height],
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: paintTex },
      packedData,
      { bytesPerRow: width * 4 },
      [width, height],
    );

    strokeTex = device.createTexture({
      size: [width, height],
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    rebuildBindGroups();
  }

  // Create normal channel texture (loaded once from asset; not replaced by openTextureFile)
  normalPaintTex = device.createTexture({
    size: [normalTexW, normalTexH],
    format: 'r32uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: normalPaintTex },
    normalPacked,
    { bytesPerRow: normalTexW * 4 },
    [normalTexW, normalTexH],
  );

  // Create roughness channel texture (loaded from asset)
  roughnessPaintTex = device.createTexture({
    size: [roughnessTexW, roughnessTexH],
    format: 'r32uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: roughnessPaintTex },
    roughnessPacked,
    { bytesPerRow: roughnessTexW * 4 },
    [roughnessTexW, roughnessTexH],
  );

  refreshSurfaceResources(initialPacked, texW, texH);

  uvCanvas.addEventListener('mousedown', (e) => {
    if (!inViewport(uvViewport, e)) return;
    if (e.button !== 0) return;
    uvDragging = true;
    uvDragIsPan = e.altKey || selectedTool === 'move' || selectedTool === 'orbit'; // alt+drag or move/orbit tool = pan UV
    uvLastMouse = { x: e.clientX, y: e.clientY };
    if (!uvDragIsPan && selectedTool !== 'brush') return;
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

  function changeBrushSize(delta: number) {
    brushControlValues.size = Math.min(1, Math.max(0, brushControlValues.size + delta));
    renderSubtoolPanel();
  }


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

  // Pre-allocated write buffers — avoids per-frame heap allocation
  const brushData       = new Float32Array(10); // 40 bytes: uv(2) + radius + on + painting + r + g + b + strength + channel_mode
  const uvTransformData = new Float32Array(5);  // scale(2) + offset(2) + channel_mode(1)
  const uniformTailData = new Float32Array(5);  // camera_pos(3) + shading_mode(1) + channel_mode(1)

  // --- Frame loop ---
  function frame() {
    const view = mat4LookAt(camera.position, camera.target, camera.up);
    const proj = mat4Perspective(camera.fov, camera.aspect, camera.near, camera.far);
    const mvp  = _mat4Multiply(proj, view);
    const channelMode = selectedChannel === 'normal'    ? 1.0
                     : selectedChannel === 'roughness' ? 2.0
                     : 0.0;
    device.queue.writeBuffer(uniformBuffer, 0, mvp);
    uniformTailData[0] = camera.position[0]; uniformTailData[1] = camera.position[1]; uniformTailData[2] = camera.position[2];
    uniformTailData[3] = selectedShading === 'rendered' ? 1.0 : 0.0;
    uniformTailData[4] = channelMode;
    device.queue.writeBuffer(uniformBuffer, 64, uniformTailData);

    brushState.radius = 0.005 + brushControlValues.size * 0.195;

    brushData[0] = brushState.uvX;   brushData[1] = brushState.uvY;
    brushData[2] = brushState.radius; brushData[3] = brushState.on;
    brushData[4] = brushState.painting;
    brushData[5] = brushState.r; brushData[6] = brushState.g; brushData[7] = brushState.b;
    brushData[8] = brushControlValues.strength;
    brushData[9] = channelMode;
    device.queue.writeBuffer(brushBuffer, 0, brushData);

    uvTransformData[0] = uvState.scaleX; uvTransformData[1] = uvState.scaleY;
    uvTransformData[2] = uvState.offX;   uvTransformData[3] = uvState.offY;
    uvTransformData[4] = channelMode;
    device.queue.writeBuffer(uvTransformBuffer, 0, uvTransformData);

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
        clearValue: { r: 0.05, g: 0.07, b: 0.095, a: 1 },
        loadOp:  'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp:  'clear',
        depthStoreOp: 'store',
      },
    });
    pass3D.setPipeline(pipeline);
    pass3D.setBindGroup(0, bindGroup);
    pass3D.setVertexBuffer(0, vertexBuffer);
    pass3D.setVertexBuffer(1, uvBuffer);
    pass3D.setVertexBuffer(2, normalsBuffer);
    pass3D.setIndexBuffer(indexBuffer, 'uint32');
    pass3D.drawIndexed(mesh.indices.length);
    pass3D.end();

    // UV pass
    const passUV = encoder.beginRenderPass({
      colorAttachments: [{
        view: uvContext.getCurrentTexture().createView(),
        clearValue: { r: 0.045, g: 0.06, b: 0.085, a: 1 },
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

  const brushColorInput = document.getElementById('brush-color') as HTMLInputElement | null;
  brushColorInput?.addEventListener('input', () => {
    const hex = brushColorInput.value;
    brushState.r = parseInt(hex.slice(1, 3), 16) / 255;
    brushState.g = parseInt(hex.slice(3, 5), 16) / 255;
    brushState.b = parseInt(hex.slice(5, 7), 16) / 255;
  });

  openModelButton?.addEventListener('click', () => {
    openModelInput?.click();
  });

  openModelInput?.addEventListener('change', async () => {
    const file = openModelInput.files?.[0];
    if (!file) return;
    try {
      await openObjFile(file);
    } catch (error) {
      console.error('Failed to open OBJ file.', error);
    } finally {
      openModelInput.value = '';
    }
  });

  // Channel-specific load/save
  let pendingChannelLoad: ChannelValue | null = null;

  openChannelInput?.addEventListener('change', async () => {
    const file = openChannelInput.files?.[0];
    if (!file || !pendingChannelLoad) return;
    try {
      const bitmap = await createImageBitmap(file);
      const { data, width, height } = imageToPackedR32(bitmap);
      if (pendingChannelLoad === 'base-color') {
        refreshSurfaceResources(data, width, height);
      } else if (pendingChannelLoad === 'normal') {
        normalPaintTex?.destroy();
        normalPaintTex = device.createTexture({
          size: [width, height],
          format: 'r32uint',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: normalPaintTex }, data, { bytesPerRow: width * 4 }, [width, height]);
        rebuildBindGroups();
      } else if (pendingChannelLoad === 'roughness') {
        roughnessPaintTex?.destroy();
        roughnessPaintTex = device.createTexture({
          size: [width, height],
          format: 'r32uint',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture: roughnessPaintTex }, data, { bytesPerRow: width * 4 }, [width, height]);
        rebuildBindGroups();
      }
    } catch (error) {
      console.error('Failed to load channel texture.', error);
    } finally {
      openChannelInput.value = '';
      pendingChannelLoad = null;
    }
  });

  async function saveChannelTexture(tex: GPUTexture, filename: string, isColor: boolean) {
    const w = tex.width;
    const h = tex.height;
    const alignedBytesPerRow = Math.ceil(w * 4 / 256) * 256;
    const bufferSize = alignedBytesPerRow * h;

    const readbackTex = device.createTexture({
      size: [w, h],
      format: 'r32uint',
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    const stagingBuffer = device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const enc = device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: tex }, { texture: readbackTex }, [w, h]);
    enc.copyTextureToBuffer({ texture: readbackTex }, { buffer: stagingBuffer, bytesPerRow: alignedBytesPerRow }, [w, h]);
    device.queue.submit([enc.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const raw = new Uint32Array(stagingBuffer.getMappedRange());
    const rgba = new Uint8ClampedArray(w * h * 4);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = y * (alignedBytesPerRow / 4) + x;
        const dst = (y * w + x) * 4;
        const packed = raw[src];
        if (isColor) {
          rgba[dst + 0] = (packed >> 0)  & 0xff;
          rgba[dst + 1] = (packed >> 8)  & 0xff;
          rgba[dst + 2] = (packed >> 16) & 0xff;
          rgba[dst + 3] = (packed >> 24) & 0xff;
        } else {
          const v = packed & 0xff;
          rgba[dst + 0] = v;
          rgba[dst + 1] = v;
          rgba[dst + 2] = v;
          rgba[dst + 3] = 255;
        }
      }
    }

    stagingBuffer.unmap();
    readbackTex.destroy();
    stagingBuffer.destroy();

    const offscreen = new OffscreenCanvas(w, h);
    const ctx2d = offscreen.getContext('2d')!;
    ctx2d.putImageData(new ImageData(rgba, w, h), 0, 0);
    const blob = await offscreen.convertToBlob({ type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.getElementById('channel-picker')?.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.channel-action-btn');
    if (!btn) return;
    const channel = btn.dataset.channel as ChannelValue;
    const action = btn.dataset.action;

    if (action === 'load') {
      pendingChannelLoad = channel;
      openChannelInput?.click();
    } else if (action === 'save') {
      if (channel === 'base-color') {
        await saveChannelTexture(paintTex, 'base-color.png', true);
      } else if (channel === 'normal') {
        await saveChannelTexture(normalPaintTex, 'normal.png', true);
      } else if (channel === 'roughness') {
        await saveChannelTexture(roughnessPaintTex, 'roughness.png', false);
      }
    }
  });
}

main().catch(console.error);

// =============================================================================
// UI — tool selection + brush subtools + parts/channel pickers
// TODO: wire brushControlValues → brushState, selectedTool → input mode
// =============================================================================

const toolOptions = ['select', 'move', 'orbit', 'brush'] as const;
type ToolOption = (typeof toolOptions)[number];

const shadingOptions = ['solid', 'rendered'] as const;
type ShadingOption = (typeof shadingOptions)[number];

const brushOptions = [
  { value: 'size', label: 'Size' },
  { value: 'strength', label: 'Strength' },
] as const;
type BrushOptionValue = (typeof brushOptions)[number]['value'];

let selectedTool: ToolOption = 'select';
let selectedShading: ShadingOption = 'solid';
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tool-button'));
const shadingButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.shading-button'));
const rightPanel = document.querySelector<HTMLDivElement>('#right-panel');
const brushPanel = document.querySelector<HTMLDivElement>('#brush-panel');
const brushOptionsPanel = document.querySelector<HTMLDivElement>('#brush-options-panel');
let selectedBrushOption: BrushOptionValue = brushOptions[0].value;
const brushControlValues = {
  size: 0.5,
  strength: 1,
};
let brushDragState: {
  control: BrushOptionValue;
  startX: number;
  startY: number;
  startValue: number;
} | null = null;

function formatBrushControlValue(value: number) {
  return value.toFixed(2).replace(/\.00$/, '');
}

function renderBrushOptionsPanel() {
  if (!brushOptionsPanel) {
    return;
  }

  brushOptionsPanel.innerHTML = `
    <div class="brush-options" aria-label="Brush options">
      ${brushOptions
        .map((option) => `
          <div class="brush-option">
            <button
              class="brush-option-body${option.value === selectedBrushOption ? ' is-active' : ''}"
              type="button"
              data-brush-option="${option.value}"
              aria-pressed="${String(option.value === selectedBrushOption)}"
            >
              <span class="brush-option-copy">
                <span class="brush-option-label">${option.label}</span>
              </span>
              <span class="brush-option-value">${formatBrushControlValue(brushControlValues[option.value])}</span>
            </button>
          </div>
        `)
        .join('')}
    </div>
  `;
}

function syncSelectedTool() {
  for (const button of toolButtons) {
    const isActive = button.dataset.tool === selectedTool;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  }

  const brushVisible = selectedTool === 'brush';
  rightPanel?.classList.toggle('brush-visible', brushVisible);
  if (brushPanel) {
    brushPanel.hidden = !brushVisible;
  }
  renderBrushOptionsPanel();
}

syncSelectedTool();

for (const button of toolButtons) {
  button.addEventListener('click', () => {
    const tool = button.dataset.tool as ToolOption | undefined;
    if (!tool || !toolOptions.includes(tool)) {
      return;
    }

    selectedTool = tool;
    syncSelectedTool();
  });
}

function syncSelectedShading() {
  for (const button of shadingButtons) {
    const isActive = button.dataset.shading === selectedShading;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  }
}

syncSelectedShading();

for (const button of shadingButtons) {
  button.addEventListener('click', () => {
    const shading = button.dataset.shading as ShadingOption | undefined;
    if (!shading || !shadingOptions.includes(shading)) {
      return;
    }

    selectedShading = shading;
    syncSelectedShading();
  });
}

brushOptionsPanel?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.brush-option-body');
  if (!button) {
    return;
  }

  const option = button.dataset.brushOption as BrushOptionValue | undefined;
  if (!option) {
    return;
  }

  selectedBrushOption = option;
  renderBrushOptionsPanel();
});

brushOptionsPanel?.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.brush-option-body');
  if (!button) {
    return;
  }

  const control = button.dataset.brushOption as BrushOptionValue | undefined;
  if (!control) {
    return;
  }

  event.preventDefault();
  selectedBrushOption = control;
  brushDragState = {
    control,
    startX: event.clientX,
    startY: event.clientY,
    startValue: brushControlValues[control],
  };
  renderBrushOptionsPanel();
});

window.addEventListener('mousemove', (event) => {
  if (!brushDragState) {
    return;
  }

  const deltaX = event.clientX - brushDragState.startX;
  const deltaY = brushDragState.startY - event.clientY;
  const nextValue = Math.min(1, Math.max(0, brushDragState.startValue + (deltaX + deltaY) * 0.005));
  brushControlValues[brushDragState.control] = nextValue;
  renderBrushOptionsPanel();
});

window.addEventListener('mouseup', () => {
  brushDragState = null;
});

// Channels — only base-color is implemented; others are stubs for future work
// TODO: wire selectedChannel → shader/paint target
const channels = [
  { value: 'base-color',        label: 'Base Color',        textureAliases: ['baseColor', 'albedo'],   description: 'Diffuse color / albedo map.' },
  { value: 'normal',            label: 'Normal',            textureAliases: ['normal'],                description: 'Surface normal detail map.' },
  { value: 'roughness',         label: 'Roughness',         textureAliases: ['roughness'],             description: 'Controls surface glossiness.' },
  { value: 'metalness',         label: 'Metallic',          textureAliases: ['metallic'],              description: 'Marks metallic regions.' },
  { value: 'ambient-occlusion', label: 'Ambient Occlusion', textureAliases: ['ao'],                    description: 'Darkens sheltered areas.' },
  { value: 'emissive',          label: 'Emissive',          textureAliases: ['emissive'],              description: 'Self-illuminated regions.' },
] as const;

type ChannelValue = (typeof channels)[number]['value'];

let selectedChannel: ChannelValue = channels[0].value;
const channelPicker = document.querySelector<HTMLDivElement>('#channel-picker');

function renderChannelPicker() {
  if (!channelPicker) {
    return;
  }

  channelPicker.innerHTML = `
    <div class="channel-picker">
      ${channels
        .map((channel) => `
          <div class="channel-option">
            <label class="channel-option-body">
              <input
                type="radio"
                name="selected-channel"
                value="${channel.value}"
                ${channel.value === selectedChannel ? 'checked' : ''}
              >
              <span class="channel-name">${channel.label}</span>
            </label>
            <div class="channel-actions">
              <button class="channel-action-btn" data-channel="${channel.value}" data-action="load" type="button" aria-label="Load ${channel.label}">
                <img src="assets/blender/file_folder.svg" alt="" class="tool-icon">
              </button>
              <button class="channel-action-btn" data-channel="${channel.value}" data-action="save" type="button" aria-label="Save ${channel.label}">
                <img src="assets/blender/file_tick.svg" alt="" class="tool-icon">
              </button>
            </div>
          </div>
        `)
        .join('')}
    </div>
  `;
}

renderChannelPicker();

channelPicker?.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.name !== 'selected-channel' || !input.checked) {
    return;
  }

  selectedChannel = input.value as ChannelValue;
});
