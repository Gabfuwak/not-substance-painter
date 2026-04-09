// Prepended with common.wgsl (Brush, Material structs + fs)

struct Uniforms {
  mvp: mat4x4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(0) @binding(3) var<uniform> brush: Brush;
@group(0) @binding(4) var paintTex: texture_2d<u32>;
@group(0) @binding(5) var<uniform> materials: array<Material, 16>;
@group(0) @binding(6) var strokeTex: texture_2d<u32>;

struct VertexOut {
  @builtin(position) pos: vec4f,
  @location(0)       uv:  vec2f,
};

@vertex
fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VertexOut {
  var out: VertexOut;
  out.pos = u.mvp * vec4f(pos, 1.0);
  out.uv  = uv;
  return out;
}
