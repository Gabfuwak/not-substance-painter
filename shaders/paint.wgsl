struct Brush {
  uv:       vec2f,
  radius:   f32,
  on:       f32,
  painting: f32,
  r:        f32,
  g:        f32,
  b:        f32,
  strength: f32,
};

@group(0) @binding(0) var<uniform> brush: Brush;
@group(0) @binding(1) var strokeTex: texture_storage_2d<r32uint, write>;

// Packing: high 16 bits = matId, low 16 bits = opacity (0–65535 maps to 0.0–1.0)
// Idempotent: re-painting the same pixel within a stroke just overwrites with the same value.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(strokeTex);
  if gid.x >= size.x || gid.y >= size.y { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  if distance(uv, brush.uv) > brush.radius { return; }

  // Pack rgba8: bits[0:7]=R, bits[8:15]=G, bits[16:23]=B, bits[24:31]=opacity
  let ri = u32(clamp(brush.r, 0.0, 1.0) * 255.0);
  let gi = u32(clamp(brush.g, 0.0, 1.0) * 255.0);
  let bi = u32(clamp(brush.b, 0.0, 1.0) * 255.0);
  let ai = u32(clamp(brush.strength, 0.0, 1.0) * 255.0);
  let packed = ri | (gi << 8u) | (bi << 16u) | (ai << 24u);
  textureStore(strokeTex, vec2i(gid.xy), vec4u(packed, 0u, 0u, 0u));
}
