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

  let stroke_matId   = stroke_packed >> 16u;
  let stroke_opacity = f32(stroke_packed & 0xFFFFu) / 65535.0;

  let committed_packed  = textureLoad(committedTex, coord).r;
  let committed_opacity = f32(committed_packed & 0xFFFFu) / 65535.0;
  let new_opacity       = committed_opacity + stroke_opacity * (1.0 - committed_opacity);
  let new_packed        = (stroke_matId << 16u) | u32(new_opacity * 65535.0);

  textureStore(committedTex, coord, vec4u(new_packed, 0u, 0u, 0u));
  textureStore(strokeTex,    coord, vec4u(0u,         0u, 0u, 0u));
}
