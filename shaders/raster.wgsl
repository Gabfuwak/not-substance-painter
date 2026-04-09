// Prepended with common.wgsl (Brush, Material structs + fs)

struct Uniforms {
  mvp:          mat4x4f,
  camera_pos:   vec3f,
  shading_mode: f32,   // 0 = solid (flat), 1 = rendered (lit)
  channel_mode: f32,   // 0 = base-color, 1 = normal
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(3) var<uniform> brush: Brush;
@group(0) @binding(4) var paintTex:       texture_2d<u32>;
@group(0) @binding(5) var normalPaintTex: texture_2d<u32>;
@group(0) @binding(6) var strokeTex:       texture_2d<u32>;
@group(0) @binding(7) var normalStrokeTex: texture_2d<u32>;

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
  // In rendered mode always show base-color; channel viz only applies in solid mode
  let effective_channel = select(u.channel_mode, 0.0, u.shading_mode >= 0.5);
  let base = surface_color(in, effective_channel);
  if u.shading_mode < 0.5 {
    return base;
  }

  // Sample normal map (composite committed + in-progress stroke for live paint feedback)
  let nsize   = vec2f(textureDimensions(normalPaintTex));
  let ntc     = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (nsize - 1.0));
  let n_color = composite_layers(
    textureLoad(normalPaintTex,  ntc, 0).r,
    textureLoad(normalStrokeTex, ntc, 0).r,
  );
  // Decode [0,1] → [-1,1] tangent-space normal, then transform to world space.
  // Approximate TBN built from vertex normal + world up — breaks at the top of the head
  // but good enough for a demo. Replace T/B with proper per-vertex tangents for accuracy.
  let N_vertex = normalize(in.world_normal);
  let T        = normalize(cross(vec3f(0.0, 1.0, 0.0), N_vertex));
  let B        = normalize(cross(N_vertex, T));
  let n_ts     = n_color.rgb * 2.0 - 1.0;
  let N        = normalize(n_ts.x * T + n_ts.y * B + n_ts.z * N_vertex);

  let light_dir = normalize(vec3f(1.0, 2.0, 1.0));
  let diffuse   = max(0.0, dot(N, light_dir));
  return vec4f(base.rgb * (0.1 + 0.9 * diffuse), base.a);
}
