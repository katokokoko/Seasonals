// Seasonals web background: soda shallows (option B)
// GLSL ES 1.00 (WebGL 1). Keep this file portable: no derivatives, and no textures except the two
// floater sprites (the Home characters, drawn only inside glass; an SkSL port takes them as child shaders).
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec4  uQuietRects[4]; // UI rects in device pixels: x, y (bottom-left origin), w, h
uniform int   uQuietCount;    // how many of uQuietRects are in use (0..4)
uniform float uScale;   // caustic cells per viewport height
uniform float uCaustic; // caustic brightness
uniform float uRefr;    // refraction amount
uniform float uTint;    // 0 = soda blue, 1 = melon
uniform float uQuiet;   // how much to calm the water under UI rects
uniform vec4  uGlassRects[6]; // glass surfaces: center x, y (device px, bottom-left origin), w, h
uniform vec4  uGlassMeta[6];  // corner radius (device px), rotation (radians, CSS clockwise), lens, frost
uniform vec4  uGlassShape[6]; // droplet variant: outline wobble (device px), droplet 0/1, wobble seed, unused
uniform float uGlassLens;     // 1 = draw the glass lenses; 0 = this layer only casts the droplets' light pools
uniform int   uGlassCount;    // how many of uGlassRects are in use (0..6)
uniform float uGlass;         // liquid glass lens strength (0 = off)
uniform vec2  uLight;         // specular light direction (screen space, y up)
uniform float uGlassOnly;     // 1 = glass layer: transparent outside glass (drawn over the water layer)
uniform vec4  uFloaters[2];   // things floating on the surface: centre x, y (device px, bottom-left), radius (device px), strength
uniform int   uFloaterCount;  // how many of uFloaters are in use (0..2)
uniform vec4  uFloaterSprite[2]; // floater sprites: half width, half height (device px, CSS scale included), rotation (rad, CSS clockwise), texture 0/1
uniform sampler2D uSprite0;   // floater images (glass layer only; straight alpha, row 0 = top)
uniform sampler2D uSprite1;
uniform vec2  uSpriteReady;   // 1 when the texture for sprite 0 / 1 is uploaded

// ---------- noise ----------
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec2 hash22(vec2 p) {
  float n = hash21(p);
  return vec2(n, hash21(p + n + 17.1));
}
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * gnoise(p); p = ROT * p; a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * gnoise(p); p = ROT * p; a *= 0.5; }
  return s;
}

// =====================================================
// Soda shallows: fbm height field, depth absorption, Voronoi edge caustics,
// chromatic split, sparkles, bubbles, rectangular quiet zones under UI
// =====================================================
float heightB(vec2 p, float t) {
  vec2 q = p * 2.2;
  q += 0.35 * vec2(fbm3(q + vec2(0.0, t * 0.05)), fbm3(q + vec2(5.2, 1.3) - t * 0.04));
  return fbm3(q * 1.3 + t * 0.03);
}
float voroEdge(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float F1 = 8.0, F2 = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    o = 0.5 + 0.38 * sin(t + 6.2831 * o);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) { F2 = d; }
  }
  return sqrt(F2) - sqrt(F1);
}
// sharp = 16 is the tuned caustic line; glass frost lowers it so the lines read as blurred
float causticLine(vec2 x, float t, float sharp) {
  float e = voroEdge(x, t);
  return exp(-e * sharp) + exp(-e * 4.5) * 0.07;
}
vec3 causticsRGB(vec2 cp, vec2 dir, float t, float sharp, float spread) {
  vec2 cp2 = mat2(0.8, -0.6, 0.6, 0.8) * cp * 1.7 + 13.7;
  vec3 c;
  c.r = causticLine(cp - dir * spread, t * 0.35, sharp) + 0.3 * causticLine(cp2 - dir * spread, t * 0.27, sharp);
  c.g = causticLine(cp,                t * 0.35, sharp) + 0.3 * causticLine(cp2,                t * 0.27, sharp);
  c.b = causticLine(cp + dir * spread, t * 0.35, sharp) + 0.3 * causticLine(cp2 + dir * spread, t * 0.27, sharp);
  return c;
}
// frost: 0 outside glass, uGlass inside. bevel: 1 at a glass edge, 0 in its flat middle
// Floaters (Home characters): outward ripple rings on the surface around each one (they bend
// the caustics and their crests catch the light, so they read even over calm quiet zones),
// and a soft shadow on the sand, shifted down-right by the water depth. Zero floaters = no change.
void floaterField(vec2 frag, float t, out vec2 rip, out float shade, out float glint) {
  rip = vec2(0.0);
  shade = 0.0;
  glint = 0.0;
  for (int i = 0; i < 2; i++) {
    if (i >= uFloaterCount) break;
    vec4 f = uFloaters[i];
    vec2 d = frag - f.xy;
    float dist = length(d);
    float r = max(f.z, 1.0);
    float x = max(dist - r * 0.75, 0.0) / uRes.y; // distance past the body, in viewport heights
    float wave = sin(x * 90.0 - t * 2.2);
    float env = exp(-x * 9.0) * smoothstep(r * 0.6, r * 0.9, dist);
    rip += (d / max(dist, 1.0)) * wave * env * 0.0045 * f.w;
    glint += pow(max(wave, 0.0), 4.0) * env * f.w;
    vec2 sd = (frag - (f.xy + vec2(0.42, -0.5) * r)) / vec2(r * 1.0, r * 0.85);
    shade = max(shade, (1.0 - smoothstep(0.3, 1.0, length(sd))) * f.w);
  }
}

vec3 renderB(vec2 frag, float t, float quiet, float frost, float bevel) {
  vec2 p = (frag - 0.5 * uRes) / uRes.y;

  // surface
  float eps = 0.004;
  float h  = heightB(p, t);
  float hx = heightB(p + vec2(eps, 0.0), t);
  float hy = heightB(p + vec2(0.0, eps), t);
  vec2 grad = vec2(hx - h, hy - h) / eps;
  float motion = mix(1.0, 0.4, quiet);
  vec2 off = -grad * uRefr * motion;
  vec2 rip;
  float shade, glint;
  floaterField(frag, t, rip, shade, glint);
  off += rip;

  // depth (low frequency, drifts very slowly)
  float d = clamp(0.52 + 1.2 * fbm3(p * 0.9 + vec2(3.1, 1.7) + t * 0.006), 0.15, 1.3);

  // sand / vanilla bottom, sampled through the refraction
  vec2 sp = p + off;
  float patches = fbm(sp * 1.6 + 11.0);
  float grain = (gnoise(sp * 190.0) + 0.5 * gnoise(sp * 420.0)) * (1.0 - 0.7 * frost);
  vec3 sand = mix(vec3(0.90, 0.86, 0.74), vec3(0.985, 0.955, 0.88), smoothstep(-0.3, 0.35, patches));
  sand += grain * 0.022;

  // liquid: soda blue <-> melon, absorbed with depth
  vec3 soda = mix(vec3(0.56, 0.88, 0.91), vec3(0.62, 0.90, 0.72), uTint);
  float a = 1.0 - exp(-d * 1.8);
  vec3 col = mix(sand, soda * mix(0.97, 1.03, patches + 0.5), a);

  // caustics
  vec2 cp = p * uScale;
  cp += 0.55 * vec2(fbm3(p * 0.9 + t * 0.03), fbm3(p * 0.9 + 7.3 - t * 0.03));
  cp += grad * 0.012 * uScale;
  cp += rip * 3.0 * uScale; // ripple rings bend the caustic network
  cp += 0.2 * vec2(gnoise(cp * 0.9 + t * 0.08), gnoise(cp * 0.9 + 5.1 - t * 0.08));
  vec2 dir = normalize(grad + vec2(1e-4));
  vec3 c = causticsRGB(cp, dir, t, mix(16.0, 6.0, frost), 0.014 + 0.05 * bevel);
  float shallow = mix(1.0, 0.55, clamp(d / 1.3, 0.0, 1.0));
  c *= shallow * uCaustic;
  c = mix(c, vec3(0.06 * uCaustic), quiet);
  c *= 1.0 - 0.7 * shade;   // the floater blocks the light that makes caustics
  col *= 1.0 - 0.13 * shade; // and casts a soft shadow on the sand
  col += c * vec3(1.0, 0.99, 0.93);
  col += glint * 0.09;       // ripple crests catch the light

  // sparkles at bright crossings
  float cg = c.g;
  float tw = gnoise(p * 95.0 + vec2(t * 0.9, -t * 0.7)) * 0.5 + 0.5;
  float sparkle = pow(max(cg, 0.0), 3.0) * smoothstep(0.62, 0.9, tw);
  col += sparkle * 1.1 * (1.0 - quiet) * (1.0 - frost);

  // bubbles (sparse, drifting slowly)
  vec2 bp = p * 6.0 + vec2(t * 0.02, t * 0.012) + off * 3.0;
  vec2 bi = floor(bp);
  vec2 bf = fract(bp) - 0.5;
  if (hash21(bi + 31.0) > 0.82) {
    vec2 bc = (hash22(bi + 7.0) - 0.5) * 0.5;
    float r = 0.035 + 0.08 * hash21(bi + 3.0);
    float bd = length(bf - bc);
    float inside = 1.0 - smoothstep(r - 0.012, r, bd);
    float rim = inside * smoothstep(r - 0.045, r - 0.012, bd);
    float hl = 1.0 - smoothstep(0.0, r * 0.35, length(bf - bc - vec2(-0.35, 0.35) * r));
    col = mix(col, col * 1.03 + 0.02, inside);
    col += rim * 0.2 + hl * 0.45;
  }

  return col;
}

float quietMask(vec2 frag) {
  float m = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uQuietCount) break;
    vec4 r = uQuietRects[i];
    vec2 c = r.xy + r.zw * 0.5;
    vec2 q = abs(frag - c) - r.zw * 0.5;
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    m = max(m, 1.0 - smoothstep(0.0, 0.12 * uRes.y, sd));
  }
  return m;
}

// =====================================================
// Liquid glass (Apple "Liquid Glass" model): each glass rect is a lens over the water.
// The bevel has a convex squircle profile y = (1 - (1 - x)^4)^(1/4) (x = 0 at the edge),
// so the slope, and with it the refraction, is steep at the rim and flat in the middle:
// the middle stays clear, the rim bends the water hard toward the centre. The rim
// catches light from uLight (plus a weaker internal reflection on the far side), the
// bevel splits colour slightly, and the body lifts saturation.
// One renderB call per pixel, two more only on the thin bevel band for dispersion.
// =====================================================
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float squircleSlope(float x) {
  float u = 1.0 - clamp(x, 0.0, 1.0);
  float s = 1.0 - u * u * u * u;
  return u * u * u * pow(max(s, 1e-4), -0.75);
}
// Droplet outline: the rounded box breathes by a few px along its perimeter (slow, > 15 s cycles)
float dropletWobble(vec2 lp, vec2 hb, vec4 shape) {
  if (shape.y < 0.5) return 0.0;
  float th = atan(lp.y / max(hb.y, 1.0), lp.x / max(hb.x, 1.0));
  return shape.x * (0.6 * sin(3.0 * th + uTime * 0.22 + shape.z) + 0.4 * sin(5.0 * th - uTime * 0.15 + 1.7 * shape.z));
}
// a small four-point sparkle; d = offset from its centre (device px), len = arm length
float starGlint(vec2 d, float len) {
  float core = exp(-dot(d, d) / 3.0);
  float arms = exp(-abs(d.x) / 0.8) * exp(-abs(d.y) / len) + exp(-abs(d.y) / 0.8) * exp(-abs(d.x) / len);
  return core * 0.9 + arms * 0.55;
}
// drop: coverage of droplet surfaces; dropRim: their crisp light line; glint: their sparkle
void glassLens(vec2 frag, out vec2 off, out float rim, out float frost, out float bevel, out float body, out float cover,
               out float drop, out float dropRim, out float glint) {
  off = vec2(0.0);
  rim = 0.0;
  frost = 0.0;
  bevel = 0.0;
  body = 0.0;
  cover = 0.0;
  drop = 0.0;
  dropRim = 0.0;
  glint = 0.0;
  if (uGlassLens < 0.5) return;
  vec2 L = normalize(uLight + vec2(1e-5));
  for (int i = 0; i < 6; i++) {
    if (i >= uGlassCount) break;
    vec4 g = uGlassRects[i];
    vec4 meta = uGlassMeta[i];
    vec4 shape = uGlassShape[i];
    float cs = cos(meta.y);
    float sn = sin(meta.y);
    vec2 d = frag - g.xy;
    vec2 lp = mat2(cs, sn, -sn, cs) * d; // screen -> element space (undo the CSS rotation)
    vec2 hb = g.zw * 0.5;
    float sd = sdRoundBox(lp, hb, meta.x) + dropletWobble(lp, hb, shape);
    float inside = 1.0 - smoothstep(-1.0, 1.0, sd);
    if (inside <= 0.0) continue;
    float e = max(-sd, 0.0);
    float bz = max(min(min(hb.x, hb.y), 0.06 * uRes.y), 1.0);
    float slope = min(squircleSlope(e / bz), 3.0) / 3.0; // 1 at the rim, 0 on the flat middle
    vec2 n = vec2(sdRoundBox(lp + vec2(1.0, 0.0), hb, meta.x) - sd, sdRoundBox(lp + vec2(0.0, 1.0), hb, meta.x) - sd);
    n = mat2(cs, -sn, sn, cs) * normalize(n + vec2(1e-5)); // outward normal, screen space
    // Snell (air 1.0 -> glass 1.5): displacement grows with the surface slope
    vec2 o = -n * slope * (0.55 * bz * meta.z) - d * (0.035 * meta.z);
    off += o * uGlass * inside;
    float nl = dot(n, L);
    bevel = max(bevel, inside * slope * uGlass);
    cover = max(cover, inside);
    if (shape.y > 0.5) {
      // droplet: only a crisp ~2 px light line, bright where the rim faces the light, a faint
      // internal reflection opposite; a sparkle placed from the centre toward the light
      float line = exp(-pow((e - 1.6) / 1.1, 2.0));
      float facing = smoothstep(-0.1, 0.85, nl) + 0.22 * smoothstep(0.3, 1.0, -nl);
      dropRim = max(dropRim, inside * line * facing * uGlass);
      // the sparkle sits on the curved rim at the corner that faces the light (where a real drop
      // shows its highlight), clear of the text in the middle
      // (on the corner arc, inset from the edge, so it stays inside rounded cards and pill bars alike)
      float m = min(hb.x, hb.y);
      float rr = clamp(meta.x, 1.0, m);
      vec2 Ll = mat2(cs, sn, -sn, cs) * L;
      vec2 corner = sign(Ll) * (hb - rr + vec2(0.7071) * max(rr - 0.24 * m, 0.0));
      vec2 at = g.xy + mat2(cs, -sn, sn, cs) * corner;
      glint = max(glint, inside * starGlint(frag - at, 0.16 * m) * uGlass);
      drop = max(drop, inside);
      continue;
    }
    float light = 0.3 + 0.7 * max(nl, 0.0) + 0.35 * pow(max(-nl, 0.0), 2.0);
    float band = (1.0 - smoothstep(0.0, 3.0, e)) + 0.35 * (1.0 - smoothstep(0.0, 12.0, e));
    rim = max(rim, inside * band * light * uGlass);
    frost = max(frost, inside * meta.w * uGlass);
    body = max(body, inside * uGlass);
  }
}

// Droplet light pools: each droplet card is a thick water lens, so it gathers the light into a
// bright band on the sand just outside its lower-right edges (away from the top-left light), with a
// faint aqua shade beyond. Drawn on the water layer, outside the cards only. No grey drop shadow.
void dropletPools(vec2 frag, inout vec3 col) {
  float pool = 0.0;
  float shade = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= uGlassCount) break;
    vec4 shape = uGlassShape[i];
    if (shape.y < 0.5) continue;
    vec4 g = uGlassRects[i];
    vec4 meta = uGlassMeta[i];
    float cs = cos(meta.y);
    float sn = sin(meta.y);
    vec2 hb = g.zw * 0.5;
    float shift = 0.18 * min(hb.x, hb.y);
    mat2 toLocal = mat2(cs, sn, -sn, cs);
    vec2 lp = toLocal * (frag - g.xy);
    float sdCard = sdRoundBox(lp, hb, meta.x) + dropletWobble(lp, hb, shape);
    if (sdCard <= 0.0 || sdCard > 2.0 * shift) continue;
    vec2 lps = toLocal * (frag + vec2(-0.6, 0.8) * shift - g.xy);
    float sdS = sdRoundBox(lps, hb, meta.x);
    float outside = smoothstep(0.0, 3.0, sdCard);
    float p = (1.0 - smoothstep(-0.6 * shift, 0.0, sdS)) * outside;
    pool = max(pool, p);
    shade = max(shade, (1.0 - smoothstep(0.0, 0.8 * shift, sdS)) * (1.0 - p) * outside);
  }
  col = mix(col, col * vec3(0.9, 0.97, 0.96), 0.6 * shade);
  col += vec3(1.0, 0.99, 0.92) * pool * 0.16;
}
// Droplet body: a window into the water. The lens shows the water a little less calmed, with the
// contrast deepened between the lines (crossings never blow out to white), and a thin aqua tint
// toward the rim only, so the middle stays clear
vec3 dropletWindow(vec2 p, float quiet, vec3 plain, float bevel) {
  vec3 bg = renderB(p, uTime, quiet * 0.6, 0.0, bevel);
  vec3 lw = vec3(0.299, 0.587, 0.114);
  float dl = dot(bg - plain, lw);
  vec3 b = bg + vec3(dl < 0.0 ? dl * 0.9 : -dl * 0.25);
  b -= vec3(max(dot(b, lw) - dot(plain, lw) - 0.08, 0.0) * 0.6);
  return b * mix(vec3(1.0), vec3(0.88, 0.97, 0.96), 0.7 * bevel);
}

// The Home characters float on the water as DOM images below the glass layer, so under a glass
// surface they would be hidden. The glass layer draws them itself, at the refracted coordinate
// (the same one the water is sampled at), so a character under a card is seen through it and bends
// at its rim like the water does.
void floaterSprites(vec2 p, inout vec3 col) {
  for (int i = 0; i < 2; i++) {
    if (i >= uFloaterCount) break;
    vec4 f = uFloaters[i];
    vec4 sp = uFloaterSprite[i];
    if (f.w <= 0.0 || sp.x <= 0.0 || sp.y <= 0.0) continue;
    float cs = cos(sp.z);
    float sn = sin(sp.z);
    vec2 lp = mat2(cs, sn, -sn, cs) * (p - f.xy); // screen -> sprite space (undo the CSS rotation)
    vec2 uv = vec2(lp.x / (2.0 * sp.x) + 0.5, 0.5 - lp.y / (2.0 * sp.y));
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
    vec4 tex = vec4(0.0);
    if (sp.w < 0.5) {
      if (uSpriteReady.x < 0.5) continue;
      tex = texture2D(uSprite0, uv);
    } else {
      if (uSpriteReady.y < 0.5) continue;
      tex = texture2D(uSprite1, uv);
    }
    col = mix(col, tex.rgb, tex.a * clamp(f.w, 0.0, 1.0));
  }
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 goff;
  float rim, frost, bevel, body, cover, drop, dropRim, glint;
  glassLens(frag, goff, rim, frost, bevel, body, cover, drop, dropRim, glint);
  // glass layer: nothing to draw outside the glass, the water layer below shows through
  if (uGlassOnly > 0.5 && cover <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float quiet = quietMask(frag) * uQuiet;
  vec3 col = renderB(frag + goff, uTime, quiet, frost, bevel);
  if (drop > 0.0) {
    col = mix(col, dropletWindow(frag + goff, quiet, col, bevel), drop);
  } else if (bevel > 0.02) {
    // chromatic dispersion on the bevel: red bends a little less, blue a little more
    col.r = renderB(frag + goff * 0.92, uTime, quiet, frost, bevel).r;
    col.b = renderB(frag + goff * 1.08, uTime, quiet, frost, bevel).b;
  }
  // characters under the glass, seen through it (below the glass's own light: rim, sparkle)
  if (uGlassOnly > 0.5 && uFloaterCount > 0) floaterSprites(frag + goff, col);
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.0 + 0.25 * body); // glass lifts saturation
  col = mix(col, col * 1.03 + 0.035, frost * 0.6); // milky body (regular glass)
  col += bevel * 0.04 * (1.0 - drop) + rim * 0.5;
  col = mix(col, vec3(1.0, 0.998, 0.985), clamp(dropRim * 0.9, 0.0, 0.9));
  col += vec3(1.0, 0.995, 0.98) * min(glint, 1.0);
  if (uGlassOnly < 0.5 && cover <= 0.0) dropletPools(frag, col);
  float alpha = uGlassOnly > 0.5 ? cover : 1.0; // premultiplied for the glass layer
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
}
