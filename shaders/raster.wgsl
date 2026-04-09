// Prepended with common.wgsl (Brush, Material structs + fs)

struct Uniforms {
  mvp:          mat4x4f,
  camera_pos:   vec3f,
  shading_mode: f32,   // 0 = solid (flat), 1 = rendered (lit)
  channel_mode: f32,   // 0 = base-color, 1 = normal, 2 = roughness
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(3) var<uniform> brush: Brush;
@group(0) @binding(4) var paintTex:          texture_2d<u32>;
@group(0) @binding(5) var normalPaintTex:    texture_2d<u32>;
@group(0) @binding(6) var strokeTex:         texture_2d<u32>;  // shared across all channels
@group(0) @binding(7) var roughnessPaintTex: texture_2d<u32>;

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

// ── GGX BRDF helpers ──────────────────────────────────────────────────────────

fn ggx_D(NdotH: f32, roughness: f32) -> f32 {
  let a  = max(0.045, roughness) * max(0.045, roughness);
  let a2 = a * a;
  let d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265359 * d * d + 1e-7);
}

fn smith_G1(NdotX: f32, roughness: f32) -> f32 {
  let a = max(0.045, roughness) * max(0.045, roughness);
  let k = a * 0.7978845608; // sqrt(2/pi)
  return NdotX / (NdotX * (1.0 - k) + k + 1e-4);
}

fn evaluateGGX(albedo: vec3f, roughness: f32, metalness: f32, N: vec3f, V: vec3f, L: vec3f) -> vec3f {
  let H     = normalize(V + L);
  let NdotL = max(0.0, dot(N, L));
  let NdotV = max(0.0, dot(N, V));
  let NdotH = max(0.0, dot(N, H));
  let VdotH = max(0.0, dot(V, H));

  let F0 = mix(vec3f(0.04), albedo, metalness);
  let F  = F0 + (1.0 - F0) * pow(max(0.0, 1.0 - VdotH), 5.0);
  let D  = ggx_D(NdotH, roughness);
  let G  = smith_G1(NdotV, roughness) * smith_G1(NdotL, roughness);

  let specular = D * F * G / max(0.0001, 4.0 * NdotL * NdotV);
  let kD       = (1.0 - metalness) * (vec3f(1.0) - F);
  return (kD * albedo / 3.14159265359 + specular) * NdotL;
}

// ─────────────────────────────────────────────────────────────────────────────

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  // In rendered mode always show base-color; channel viz only applies in solid mode
  let effective_channel = select(u.channel_mode, 0.0, u.shading_mode >= 0.5);
  let base = surface_color(in, effective_channel);
  if u.shading_mode < 0.5 {
    return base;
  }

  // ── Normal map ──
  let nsize   = vec2f(textureDimensions(normalPaintTex));
  let ntc     = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (nsize - 1.0));
  let n_color = composite_layers(
    textureLoad(normalPaintTex, ntc, 0).r,
    select(0u, textureLoad(strokeTex, ntc, 0).r, brush.channel_mode >= 0.5 && brush.channel_mode < 1.5),
  );
  // Approximate TBN from vertex normal + world up
  let N_vertex = normalize(in.world_normal);
  let T        = normalize(cross(vec3f(0.0, 1.0, 0.0), N_vertex));
  let B        = normalize(cross(N_vertex, T));
  let n_ts     = n_color.rgb * 2.0 - 1.0;
  let N        = normalize(n_ts.x * T + n_ts.y * B + n_ts.z * N_vertex);

  // ── Roughness ──
  let rsize     = vec2f(textureDimensions(roughnessPaintTex));
  let rtc       = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (rsize - 1.0));
  let r_raw     = composite_layers(
    textureLoad(roughnessPaintTex, rtc, 0).r,
    select(0u, textureLoad(strokeTex, rtc, 0).r, brush.channel_mode >= 1.5),
  );
  let roughness = r_raw.r;

  // ── GGX shading ──
  let albedo   = base.rgb;
  let V        = normalize(u.camera_pos - in.world_pos);
  let L        = normalize(vec3f(1.0, 2.0, 1.0));
  let radiance = vec3f(3.0);

  let brdf    = evaluateGGX(albedo, roughness, 0.0, N, V, L);
  let ambient = 0.03 * albedo;
  return vec4f(ambient + brdf * radiance, base.a);
}
