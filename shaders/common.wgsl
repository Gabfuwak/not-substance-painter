struct Brush {
  uv:       vec2f,
  radius:   f32,
  on:       f32,
  painting: f32,
  matId:    f32,
  _pad0:    f32,
  _pad1:    f32,
};

struct Material {
  baseColor: vec3f,
  roughness: f32,
};

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let size  = vec2f(textureDimensions(paintTex));
  let tc    = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (size - 1.0));
  let matId = textureLoad(paintTex, tc, 0).r;

  let baseColor = textureSample(uTexture, uSampler, in.uv);
  // min clamp guards against out-of-bounds; future: expand per-material logic here (smart materials)
  let mat = materials[min(matId, 15u)];
  var color = select(vec4f(mat.baseColor, 1.0), baseColor, matId == 0u);

  if brush.on > 0.5 {
    let d         = distance(in.uv, brush.uv);
    let lineWidth = brush.radius * 0.05;
    let t         = 1.0 - smoothstep(0.0, lineWidth, abs(d - brush.radius));
    let ringColor = select(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0), brush.painting > 0.5);
    color = mix(color, ringColor, t);
  }

  return color;
}
