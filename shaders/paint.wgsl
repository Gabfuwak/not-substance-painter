struct Brush {
  uv:           vec2f,
  radius:       f32,
  on:           f32,
  painting:     f32,
  r:            f32,
  g:            f32,
  b:            f32,
  strength:     f32,
  channel_mode: f32,  // 0=base-color, 1=normal, 2=roughness
};

@group(0) @binding(0) var<uniform> brush: Brush;
@group(0) @binding(1) var strokeTex: texture_storage_2d<r32uint, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(strokeTex);
  if gid.x >= size.x || gid.y >= size.y { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  if distance(uv, brush.uv) > brush.radius { return; }

  let ai = u32(clamp(brush.strength, 0.0, 1.0) * 255.0);
  var packed: u32;
  if brush.channel_mode >= 1.5 {
    // Scalar channel (roughness, metalness, …) — only R used, G/B=0
    let ri  = u32(clamp(brush.r, 0.0, 1.0) * 255.0);
    packed  = ri | (ai << 24u);
  } else {
    // Base-color or normal — full RGB
    let ri = u32(clamp(brush.r, 0.0, 1.0) * 255.0);
    let gi = u32(clamp(brush.g, 0.0, 1.0) * 255.0);
    let bi = u32(clamp(brush.b, 0.0, 1.0) * 255.0);
    packed = ri | (gi << 8u) | (bi << 16u) | (ai << 24u);
  }
  textureStore(strokeTex, vec2i(gid.xy), vec4u(packed, 0u, 0u, 0u));
}
