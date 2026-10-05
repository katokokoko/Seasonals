// Seasonals web background: soda shallows (option B)
// GLSL ES 1.00 (WebGL 1). Keep this file portable: no textures, no derivatives.
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
// Soda shallows: looking straight down through shallow clear water at a sand bottom.
// The bottom (sand grain, specks, ripple marks) is lit by a Voronoi caustic network:
// the light is conserved, so the lines are bright, the cell interiors dimmer and a band
// just beside each line dimmer still. The water absorbs red most with depth (mint to teal).
// The surface wobbles the view of the bottom, its ripple crests catch the light as thin
// strands, and small star sparkles twinkle. Rectangular quiet zones calm it under UI.
// =====================================================
const vec2 FLOW = vec2(0.8, 0.6); // the swell runs along this: cells stretch, strands cross it

// a small four-point sparkle; d = offset from its centre (device px), len = arm length
float starGlint(vec2 d, float len) {
  float core = exp(-dot(d, d) / 3.0);
  float arms = exp(-abs(d.x) / 0.8) * exp(-abs(d.y) / len) + exp(-abs(d.y) / 0.8) * exp(-abs(d.x) / len);
  return core * 0.9 + arms * 0.55;
}

float heightB(vec2 p, float t) {
  vec2 q = p * 2.2;
  q += 0.35 * vec2(fbm3(q + vec2(0.0, t * 0.05)), fbm3(q + vec2(5.2, 1.3) - t * 0.04));
  return fbm3(q * 1.3 + t * 0.03);
}
// x: distance to the nearest cell wall (F2 - F1), y: to the nearest crossing (F3 - F1)
vec2 voroEdge3(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float F1 = 8.0, F2 = 8.0, F3 = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    o = 0.5 + 0.45 * sin(t + 6.2831 * o);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < F1) { F3 = F2; F2 = F1; F1 = d; } else if (d < F2) { F3 = F2; F2 = d; } else if (d < F3) { F3 = d; }
  }
  float s1 = sqrt(F1);
  return vec2(sqrt(F2) - s1, sqrt(F3) - s1);
}
float voroEdge(vec2 x, float t) { return voroEdge3(x, t).x; }
// rgb: the caustic light (crisp core + soft glow, split slightly by colour), a: the shade band
// just beside the lines (the light there was pulled into the line). sharp = 16 is the tuned line;
// glass frost and quiet zones lower it so the lines read as blurred
vec4 causticsRGB(vec2 cp, vec2 dir, float t, float sharp, float spread) {
  vec2 eg = voroEdge3(cp, t * 0.35);
  vec3 e = vec3(voroEdge(cp - dir * spread, t * 0.35), eg.x, voroEdge(cp + dir * spread, t * 0.35));
  vec3 c = exp(-e * sharp) + 0.1 * exp(-e * sharp * 0.22);
  c += 0.45 * exp(-eg.y * sharp * 0.7); // where walls meet, the focused light is brightest
  // a second, wider network only as a faint glow (the photo's doubled lines, never a crisp tile pattern)
  vec2 cp2 = mat2(0.8, -0.6, 0.6, 0.8) * cp * 0.62 + 13.7;
  c += 0.1 * exp(-voroEdge(cp2, t * 0.27) * 5.0);
  float band = exp(-eg.x * 2.4) * (1.0 - exp(-eg.x * sharp * 0.5));
  return vec4(c, band);
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
  float calm = 1.0 - quiet;
  float clear = calm * (1.0 - frost);

  // surface: the fbm swell, plus a train of small ripples running along FLOW in bundles
  float eps = 0.004;
  float h  = heightB(p, t);
  float hx = heightB(p + vec2(eps, 0.0), t);
  float hy = heightB(p + vec2(0.0, eps), t);
  vec2 grad = vec2(hx - h, hy - h) / eps;
  float motion = mix(1.0, 0.4, quiet);
  float bend = fbm3(p * 1.1 + vec2(t * 0.02, -t * 0.015));
  float phase = dot(p, FLOW) * 34.0 + bend * 14.0 - t * 0.35;
  float bundle = smoothstep(0.0, 0.3, fbm3(p * 1.6 + 4.0 + vec2(-t * 0.012, t * 0.01)));
  vec2 off = -grad * uRefr * motion + FLOW * (sin(phase) * 0.0016 * bundle * motion);
  vec2 rip;
  float shade, glint;
  floaterField(frag, t, rip, shade, glint);
  off += rip;

  // depth (low frequency, drifts very slowly; a little deeper toward the top)
  // shallow sand patches and deeper aqua patches, like the photo (not one even tint)
  float d = 0.08 + 1.05 * smoothstep(-0.28, 0.32, fbm3(p * 0.7 + vec2(3.1, 1.7) + t * 0.006) + 0.22 * dot(p, vec2(-0.35, 0.95)));
  float dv = mix(0.62, d, mix(1.0, 0.3, quiet)); // calmer depth changes under UI

  // sand bottom, sampled through the refraction: patches, ripple marks, grain, specks
  vec2 sp = p + off;
  float patches = fbm(sp * 1.6 + 11.0);
  vec3 sand = mix(vec3(0.86, 0.83, 0.71), vec3(0.975, 0.95, 0.86), mix(smoothstep(-0.3, 0.35, patches), 0.6, 0.6 * quiet));
  sand *= 1.0 + 0.03 * calm * sin(dot(sp, vec2(0.45, 0.89)) * 70.0 + 4.0 * patches);
  // grain and specks follow the bottom only loosely: the ripple train's refraction would stretch
  // anything this fine into hair-like streaks. The grain is a fine noise plus a per-grain hash
  vec2 gp0 = p + off * 0.25;
  float grain = (gnoise(gp0 * 210.0) + 0.55 * (hash21(floor(gp0 * uRes.y * 0.75)) - 0.5)) * (1.0 - 0.7 * frost) * mix(1.0, 0.3, quiet);
  sand += grain * 0.085;
  vec2 gp = gp0 * 150.0;
  vec2 gi = floor(gp);
  float hs = hash21(gi + 5.0);
  if (hs > 0.9) {
    float sd = length(fract(gp) - 0.5 - (hash22(gi) - 0.5) * 0.5);
    float sk = (1.0 - smoothstep(0.1, 0.28, sd)) * mix(0.7, 0.3, quiet);
    sand = mix(sand, hs > 0.97 ? vec3(1.0, 0.985, 0.94) : sand * 0.84, sk);
  }

  // caustics
  vec2 cp = p * uScale * 1.15;
  cp += 0.85 * vec2(fbm3(p * 0.9 + t * 0.03), fbm3(p * 0.9 + 7.3 - t * 0.03)); // cells grow and shrink across the view
  cp += grad * 0.012 * uScale;
  cp += rip * 3.0 * uScale; // ripple rings bend the caustic network
  cp += 0.32 * vec2(gnoise(cp * 0.9 + t * 0.08), gnoise(cp * 0.9 + 5.1 - t * 0.08)); // bends the cell walls round
  cp += 0.16 * vec2(gnoise(cp * 1.9 + 2.7 - t * 0.06), gnoise(cp * 1.9 + 9.4 + t * 0.06));
  // stretch the cells along the swell and let them wave across it
  vec2 nf = vec2(-FLOW.y, FLOW.x);
  float along = dot(cp, FLOW);
  float across = dot(cp, nf);
  cp = FLOW * along * 0.7 + nf * (across * 1.3 + 0.3 * sin(along * 0.9 + t * 0.05));
  vec2 dir = normalize(grad + vec2(1e-4));
  float width = mix(0.55, 1.4, gnoise(cp * 0.35 + 2.3) + 0.5); // line width varies along the network
  float sharp = mix(16.0, 6.0, frost) * width * mix(1.0, 0.4, quiet);
  vec4 cb = causticsRGB(cp, dir, t, sharp, 0.014 + 0.05 * bevel);
  vec3 c = cb.rgb;
  float shallow = mix(1.0, 0.55, clamp(d / 1.2, 0.0, 1.0));
  c *= shallow * uCaustic * mix(1.0, 1.25, gnoise(cp * 0.21 + 8.1) + 0.5);
  c = mix(c, vec3(0.2 * uCaustic), quiet * 0.92);
  c *= 1.0 - 0.7 * shade;   // the floater blocks the light that makes caustics

  // water: absorbs red most, then blue (soda) or green less (melon), with depth; a thin aqua in-scatter
  vec3 k = mix(vec3(0.58, 0.08, 0.06), vec3(0.5, 0.04, 0.17), uTint);
  vec3 bottom = sand * exp(-k * dv * 1.3);
  // light on the bottom: conserved, so cell interiors sit below the lines and the band beside them
  // lower still. The focused lines run toward cream white (they saturate like the photo's)
  float base = 0.92 - 0.14 * cb.a * uCaustic * 2.0 * calm;
  vec3 col = bottom * base + c * 1.05 * mix(bottom, vec3(1.0, 0.99, 0.93), 0.7);
  col *= 1.0 - 0.13 * shade; // the floater casts a soft shadow on the sand
  col += vec3(0.25, 0.65, 0.7) * (1.0 - exp(-dv * 0.9)) * 0.16;
  col = mix(col, col * 1.04 + 0.025, quiet); // quiet zones sit a little lighter behind the UI

  // surface: ripple crests that face the light show as thin flowing strands
  float strand = pow(max(sin(phase + 0.9), 0.0), 30.0) * bundle;
  col += strand * 0.4 * clear * vec3(1.0, 1.0, 0.97);
  col += glint * 0.09;       // floater ripple crests catch the light

  // sparkles: a soft dot at bright crossings, and sparse twinkling four-point stars
  float cg = c.g;
  float tw = gnoise(p * 95.0 + vec2(t * 0.9, -t * 0.7)) * 0.5 + 0.5;
  col += pow(max(cg, 0.0), 3.0) * smoothstep(0.62, 0.9, tw) * 0.8 * clear;
  vec2 si = floor(frag / 96.0);
  float sh = hash21(si + 71.0);
  if (sh > 0.88) {
    vec2 sc = (si + 0.2 + 0.6 * hash22(si + 3.0)) * 96.0;
    float on = max(sin(t * (0.5 + sh) + sh * 40.0), 0.0);
    col += starGlint(frag - sc, 6.0 + 4.0 * hash21(si + 9.0)) * on * on * on * 0.85 * clear;
  }

  // tiny bubbles (sparse, drifting slowly)
  vec2 bp = frag / 48.0 + vec2(t * 0.12, t * 0.07) + off * 3.0;
  vec2 bi = floor(bp);
  if (hash21(bi + 31.0) > 0.93) {
    vec2 bf = fract(bp) - 0.5 - (hash22(bi + 7.0) - 0.5) * 0.6;
    float r = (1.1 + 1.2 * hash21(bi + 3.0)) / 48.0;
    float bd = length(bf);
    float inside = 1.0 - smoothstep(r * 0.6, r, bd);
    float ring = inside * smoothstep(r * 0.2, r * 0.8, bd);
    col = mix(col, col * 0.93, ring * 0.6) + (inside - ring) * 0.12 * calm;
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
      // the sparkle sits just inside the rim on the side that faces the light (where a real drop
      // shows its highlight), clear of the text in the middle. It is the point where a ray from the
      // centre toward the light meets the rounded outline, pulled in by an inset, so it glides along
      // the rim as uLight eases after the pointer (never jumping between corners). The light
      // direction is stretched by the half size first, so a diagonal light reaches the corner of a
      // wide card (the default top-left light rests near the top-left corner)
      float m = min(hb.x, hb.y);
      float rr = clamp(meta.x, 1.0, m);
      vec2 dir = normalize((mat2(cs, sn, -sn, cs) * L) * hb + vec2(1e-5));
      vec2 spot = dir * min(hb.x / max(abs(dir.x), 1e-4), hb.y / max(abs(dir.y), 1e-4)); // on the plain box
      for (int k = 0; k < 4; k++) spot -= dir * (sdRoundBox(spot, hb, rr) + 0.22 * m);   // onto the inset rounded outline
      vec2 at = g.xy + mat2(cs, -sn, sn, cs) * spot;
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
