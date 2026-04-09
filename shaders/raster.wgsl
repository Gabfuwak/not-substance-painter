// Prepended with common.wgsl (Brush, Material structs + fs)

struct Uniforms {
  mvp:          mat4x4f,
  camera_pos:   vec3f,
  shading_mode: f32,   // 0 = solid (flat), 1 = rendered (lit)
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(3) var<uniform> brush: Brush;
@group(0) @binding(4) var paintTex: texture_2d<u32>;
@group(0) @binding(6) var strokeTex: texture_2d<u32>;

struct VertexOut {
  @builtin(position) pos:          vec4f,
  @location(0)       uv:           vec2f,
  @location(1)       world_pos:    vec3f,
  @location(2)       world_normal: vec3f,
};

@vertex
fn vs(@location(0) pos: vec3f, @location(1) uv: vec2f, @location(2) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.pos          = u.mvp * vec4f(pos, 1.0);
  out.uv           = uv;
  out.world_pos    = pos;     // model matrix is identity
  out.world_normal = normal;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let base = surface_color(in);
  if u.shading_mode < 0.5 {
    return base;
  }
  let light_dir = normalize(vec3f(1.0, 2.0, 1.0));
  let N         = normalize(in.world_normal);
  let diffuse   = max(0.0, dot(N, light_dir));
  return vec4f(base.rgb * (0.1 + 0.9 * diffuse), base.a);
}
