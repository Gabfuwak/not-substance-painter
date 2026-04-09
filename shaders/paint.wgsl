struct Brush {
  uv:       vec2f,
  radius:   f32,
  on:       f32,
  painting: f32,
  matId:    f32,
  strength: f32,
  _pad1:    f32,
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

  let packed = (u32(brush.matId) << 16u) | u32(brush.strength * 65535.0);
  textureStore(strokeTex, vec2i(gid.xy), vec4u(packed, 0u, 0u, 0u));
}
