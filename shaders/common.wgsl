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

struct Material {
  baseColor: vec3f,
  roughness: f32,
};

@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(paintTex));
  let tc   = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (size - 1.0));

  let committed_packed   = textureLoad(paintTex,  tc, 0).r;
  let committed_matId    = committed_packed >> 16u;
  let committed_opacity  = f32(committed_packed & 0xFFFFu) / 65535.0;

  let stroke_packed  = textureLoad(strokeTex, tc, 0).r;
  let stroke_matId   = stroke_packed >> 16u;
  let stroke_opacity = f32(stroke_packed & 0xFFFFu) / 65535.0;

  let baseColor = textureSample(uTexture, uSampler, in.uv);
  // Layer: base → committed → stroke
  let committed_mat = materials[min(committed_matId, 15u)];
  let stroke_mat    = materials[min(stroke_matId, 15u)];
  var color = mix(baseColor, vec4f(committed_mat.baseColor, 1.0), committed_opacity);
  color     = mix(color,     vec4f(stroke_mat.baseColor,    1.0), stroke_opacity);

  if brush.on > 0.5 {
    let d         = distance(in.uv, brush.uv);
    let lineWidth = brush.radius * 0.05;
    let t         = 1.0 - smoothstep(0.0, lineWidth, abs(d - brush.radius));
    let ringColor = select(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0), brush.painting > 0.5);
    color = mix(color, ringColor, t);
  }

  return color;
}
