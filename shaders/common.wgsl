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

fn unpack_rgba8(packed: u32) -> vec4f {
  let rgb = vec3f(f32((packed>>0u)&0xFFu), f32((packed>>8u)&0xFFu), f32((packed>>16u)&0xFFu)) / 255.0;
  let a   = f32((packed >> 24u) & 0xFFu) / 255.0;
  return vec4f(rgb, a);
}

fn composite_layers(committed_packed: u32, stroke_packed: u32) -> vec4f {
  let c = unpack_rgba8(committed_packed);
  let s = unpack_rgba8(stroke_packed);
  var color = vec4f(c.rgb, c.a);
  color     = mix(color, vec4f(s.rgb, 1.0), s.a);
  return color;
}

fn surface_color(in: VertexOut, channel_mode: f32) -> vec4f {
  let size = vec2f(textureDimensions(paintTex));
  let tc   = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (size - 1.0));

  var color: vec4f;
  if channel_mode >= 0.5 {
    // Normal channel
    let nsize = vec2f(textureDimensions(normalPaintTex));
    let ntc   = vec2i(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * (nsize - 1.0));
    color = composite_layers(
      textureLoad(normalPaintTex,  ntc, 0).r,
      textureLoad(normalStrokeTex, ntc, 0).r,
    );
  } else {
    // Base-color channel
    color = composite_layers(
      textureLoad(paintTex,  tc, 0).r,
      textureLoad(strokeTex, tc, 0).r,
    );
  }

  if brush.on > 0.5 {
    let d         = distance(in.uv, brush.uv);
    let lineWidth = brush.radius * 0.05;
    let t         = 1.0 - smoothstep(0.0, lineWidth, abs(d - brush.radius));
    let ringColor = select(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0), brush.painting > 0.5);
    color = mix(color, ringColor, t);
  }

  return color;
}
