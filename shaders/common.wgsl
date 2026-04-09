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


@fragment
fn fs(in: VertexOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(paintTex));
  let tc   = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (size - 1.0));

  // Unpack rgba8: bits[0:7]=R, bits[8:15]=G, bits[16:23]=B, bits[24:31]=opacity
  let c_packed  = textureLoad(paintTex,  tc, 0).r;
  let c_rgb     = vec3f(f32((c_packed>>0u)&0xFFu), f32((c_packed>>8u)&0xFFu), f32((c_packed>>16u)&0xFFu)) / 255.0;
  let c_opacity = f32((c_packed >> 24u) & 0xFFu) / 255.0;

  let s_packed  = textureLoad(strokeTex, tc, 0).r;
  let s_rgb     = vec3f(f32((s_packed>>0u)&0xFFu), f32((s_packed>>8u)&0xFFu), f32((s_packed>>16u)&0xFFu)) / 255.0;
  let s_opacity = f32((s_packed >> 24u) & 0xFFu) / 255.0;

  let baseColor = textureSample(uTexture, uSampler, in.uv);
  // Layer: base texture → committed paint → in-progress stroke
  var color = mix(baseColor, vec4f(c_rgb, 1.0), c_opacity);
  color     = mix(color,     vec4f(s_rgb, 1.0), s_opacity);

  if brush.on > 0.5 {
    let d         = distance(in.uv, brush.uv);
    let lineWidth = brush.radius * 0.05;
    let t         = 1.0 - smoothstep(0.0, lineWidth, abs(d - brush.radius));
    let ringColor = select(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0), brush.painting > 0.5);
    color = mix(color, ringColor, t);
  }

  return color;
}
