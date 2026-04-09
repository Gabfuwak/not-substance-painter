// Prepended with common.wgsl (Brush, Material structs + fs)

struct Transform {
  scale:  vec2f,
  offset: vec2f,
};

@group(0) @binding(0) var<uniform> u: Transform;
@group(0) @binding(3) var<uniform> brush: Brush;
@group(0) @binding(4) var paintTex: texture_2d<u32>;
@group(0) @binding(6) var strokeTex: texture_2d<u32>;

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
  return surface_color(in);
}
