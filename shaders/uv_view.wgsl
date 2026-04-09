struct Transform {
  scale:  vec2f,
  offset: vec2f,
};

struct Brush {
  uv:       vec2f,
  radius:   f32,
  on:       f32,
  painting: f32,
  matId:    f32,
  _pad0:    f32,
  _pad1:    f32,
};

struct Material {
  baseColor: vec3f,
  roughness: f32,
};

@group(0) @binding(0) var<uniform> u: Transform;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(0) @binding(3) var<uniform> brush: Brush;
@group(0) @binding(4) var paintTex: texture_2d<u32>;
@group(0) @binding(5) var<uniform> materials: array<Material, 16>;

struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@vertex
fn vs(@location(0) uv: vec2f) -> VertexOut {
  var out: VertexOut;
  var clip = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  out.pos = vec4f(clip * u.scale + u.offset, 0.0, 1.0);
  out.uv  = uv;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let size  = vec2f(textureDimensions(paintTex));
  let tc    = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (size - 1.0));
  let matId = textureLoad(paintTex, tc, 0).r;

  let baseColor = textureSample(uTexture, uSampler, in.uv);
  // min clamp guards against out-of-bounds; future: expand per-material logic here (smart materials)
  let mat = materials[min(matId, 15u)];
  var color = select(vec4f(mat.baseColor, 1.0), baseColor, matId == 0u);

  if brush.on > 0.5 {
    let d         = distance(in.uv, brush.uv);
    let lineWidth = brush.radius * 0.05;
    let t         = 1.0 - smoothstep(0.0, lineWidth, abs(d - brush.radius));
    let ringColor = select(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0), brush.painting > 0.5);
    color = mix(color, ringColor, t);
  }

  return color;
}
