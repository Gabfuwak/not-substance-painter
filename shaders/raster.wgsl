struct Uniforms {
  mvp: mat4x4f,
};

struct Brush {
  uv:     vec2f,
  radius: f32,
  on: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(0) @binding(3) var<uniform> brush: Brush;

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
  var color = textureSample(uTexture, uSampler, in.uv);
  if brush.on > 0.5 {
    let d = distance(in.uv, brush.uv);
    let lineWidth = brush.radius * 0.05;
    let t = 1.0 - smoothstep(0.0, lineWidth, abs(d - brush.radius));
    color = mix(color, vec4f(1.0, 0.0, 0.0, 1.0), t);
  }
  return color;
}
