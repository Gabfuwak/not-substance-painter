struct Brush {
  uv:       vec2f,
  radius:   f32,
  on:       f32,
  painting: f32,
  matId:    f32,
  _pad0:    f32,
  _pad1:    f32,
};

@group(0) @binding(0) var<uniform> brush: Brush;
@group(0) @binding(1) var paintTex: texture_storage_2d<r32uint, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(paintTex);
  if gid.x >= size.x || gid.y >= size.y { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  if distance(uv, brush.uv) <= brush.radius {
    textureStore(paintTex, vec2i(gid.xy), vec4u(u32(brush.matId), 0u, 0u, 0u));
  }
}
