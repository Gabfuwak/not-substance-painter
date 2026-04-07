struct Uniforms {
  mvp: mat4x4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

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

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  return textureSample(uTexture, uSampler, in.uv);
}
