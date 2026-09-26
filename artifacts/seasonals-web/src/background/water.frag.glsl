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
float causticLine(vec2 x, float t) {
  float e = voroEdge(x, t);
  return exp(-e * 16.0) + exp(-e * 4.5) * 0.07;
}
vec3 causticsRGB(vec2 cp, vec2 dir, float t) {
  vec2 cp2 = mat2(0.8, -0.6, 0.6, 0.8) * cp * 1.7 + 13.7;
  float spread = 0.014;
  vec3 c;
  c.r = causticLine(cp - dir * spread, t * 0.35) + 0.3 * causticLine(cp2 - dir * spread, t * 0.27);
  c.g = causticLine(cp,                t * 0.35) + 0.3 * causticLine(cp2,                t * 0.27);
  c.b = causticLine(cp + dir * spread, t * 0.35) + 0.3 * causticLine(cp2 + dir * spread, t * 0.27);
  return c;
}
vec3 renderB(vec2 frag, float t, float quiet) {
  vec2 p = (frag - 0.5 * uRes) / uRes.y;

  // surface
  float eps = 0.004;
  float h  = heightB(p, t);
  float hx = heightB(p + vec2(eps, 0.0), t);
  float hy = heightB(p + vec2(0.0, eps), t);
  vec2 grad = vec2(hx - h, hy - h) / eps;
  float motion = mix(1.0, 0.4, quiet);
  vec2 off = -grad * uRefr * motion;

  // depth (low frequency, drifts very slowly)
  float d = clamp(0.52 + 1.2 * fbm3(p * 0.9 + vec2(3.1, 1.7) + t * 0.006), 0.15, 1.3);

  // sand / vanilla bottom, sampled through the refraction
  vec2 sp = p + off;
  float patches = fbm(sp * 1.6 + 11.0);
  float grain = gnoise(sp * 190.0) + 0.5 * gnoise(sp * 420.0);
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
  cp += 0.2 * vec2(gnoise(cp * 0.9 + t * 0.08), gnoise(cp * 0.9 + 5.1 - t * 0.08));
  vec2 dir = normalize(grad + vec2(1e-4));
  vec3 c = causticsRGB(cp, dir, t);
  float shallow = mix(1.0, 0.55, clamp(d / 1.3, 0.0, 1.0));
  c *= shallow * uCaustic;
  c = mix(c, vec3(0.06 * uCaustic), quiet);
  col += c * vec3(1.0, 0.99, 0.93);

  // sparkles at bright crossings
  float cg = c.g;
  float tw = gnoise(p * 95.0 + vec2(t * 0.9, -t * 0.7)) * 0.5 + 0.5;
  float sparkle = pow(max(cg, 0.0), 3.0) * smoothstep(0.62, 0.9, tw);
  col += sparkle * 1.1 * (1.0 - quiet);

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

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 col = renderB(frag, uTime, quietMask(frag) * uQuiet);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
