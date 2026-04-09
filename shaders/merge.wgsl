// Merges the current stroke layer into the committed layer, then clears the stroke layer.
// Run once on mouseup.

@group(0) @binding(0) var committedTex: texture_storage_2d<r32uint, read_write>;
@group(0) @binding(1) var strokeTex:    texture_storage_2d<r32uint, read_write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(committedTex);
  if gid.x >= size.x || gid.y >= size.y { return; }

  let coord        = vec2i(gid.xy);
  let stroke_packed = textureLoad(strokeTex, coord).r;
  if stroke_packed == 0u { return; }

  // Unpack stroke rgba8
  let s_r = f32((stroke_packed >>  0u) & 0xFFu) / 255.0;
  let s_g = f32((stroke_packed >>  8u) & 0xFFu) / 255.0;
  let s_b = f32((stroke_packed >> 16u) & 0xFFu) / 255.0;
  let s_a = f32((stroke_packed >> 24u) & 0xFFu) / 255.0;

  let committed_packed = textureLoad(committedTex, coord).r;
  let c_r = f32((committed_packed >>  0u) & 0xFFu) / 255.0;
  let c_g = f32((committed_packed >>  8u) & 0xFFu) / 255.0;
  let c_b = f32((committed_packed >> 16u) & 0xFFu) / 255.0;
  let c_a = f32((committed_packed >> 24u) & 0xFFu) / 255.0;

  // Porter-Duff over (straight alpha — divide to keep stored color un-premultiplied)
  let out_a = s_a + c_a * (1.0 - s_a);
  let out_r = (s_r * s_a + c_r * c_a * (1.0 - s_a)) / out_a;
  let out_g = (s_g * s_a + c_g * c_a * (1.0 - s_a)) / out_a;
  let out_b = (s_b * s_a + c_b * c_a * (1.0 - s_a)) / out_a;
  let new_packed = u32(out_r * 255.0) | (u32(out_g * 255.0) << 8u) | (u32(out_b * 255.0) << 16u) | (u32(out_a * 255.0) << 24u);

  textureStore(committedTex, coord, vec4u(new_packed, 0u, 0u, 0u));
  textureStore(strokeTex,    coord, vec4u(0u, 0u, 0u, 0u));
}
