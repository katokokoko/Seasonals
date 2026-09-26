# Seasonals Web: Soda Shallows Background

Spec for Claude Code. As of 2026-09-26.

## Goal and scope

Build the full-screen animated background for the Seasonals web app (desktop browsers on macOS and Windows): a top-down view of shallow cream soda over vanilla-coloured sand, with slowly drifting caustic light. It must sit behind the entire UI, stay quiet under UI cards so the calendar remains readable, and cost little GPU.

This spec implements option B from the prototype: a single full-screen fragment shader in raw WebGL 1, with no three.js, React Three Fiber or drei. The shader is final and is included verbatim below; the work is wiring it into the app, exposing the props, and meeting the runtime and acceptance rules.

In scope:

- A `WaterBackground` React component that renders the shader on a fixed canvas behind the UI
- A quiet-zone contract so UI containers can register the area under them
- Props for colour, caustic scale, strength, refraction, speed and quiet strength
- Pause on hidden tab, reduced-motion handling, DPR cap

Out of scope for this task:

- Mobile and React Native (a later SkSL port for Expo will reuse the same GLSL, so keep the shader untouched)
- Device-tilt liquid physics (a separate feature)
- Any 3D geometry, reflections, or physically simulated water

Stack assumption: React with TypeScript on the web build. If the web app is Expo web, mount the same component in the web entry; the component only depends on `document`, `window` and a `<canvas>`.

## Reference

The target look is side B of the interactive prototype: [Soda shallows A/B demo](https://claude.ai/artifact/75ZutXsnuUM9EVP8PcPqa5). Open it, switch to "B のみ", toggle "UIを重ねる", and treat what you see as the visual spec. The demo's `soda-water-ab.html` contains the same shader plus the reference JavaScript wiring; copy the wiring logic, not the demo chrome. Where the demo and this document differ, this document wins (the shader below has stronger quiet zones and supports four rects).

What the picture is made of, in order of importance:

1. Caustics: thin, bright, warm-white lines forming rounded cells about 1/5 of the viewport height across, with a faint cyan and yellow fringe. This is the element that reads as water.
2. Liquid colour: a mint between soda blue and melon green, deeper in some patches and almost transparent in others, so the sand shows through unevenly.
3. Sand: vanilla cream with soft lighter and darker patches and a very fine grain, seen through gentle refraction.
4. Sparkles at bright crossings and a few small, slow-drifting bubbles.

Palette baked into the shader (do not restyle these in CSS):

| Role | Hex (approx.) | Notes |
| --- | --- | --- |
| Sand light | #FBF3E0 | vanilla patches |
| Sand dark | #E6DBBD | shadowed patches |
| Soda blue end | #8FE0E8 | `tint = 0` |
| Melon end | #9EE5B8 | `tint = 1` |
| Default liquid | #97E3D0 | `tint = 0.5` |
| Caustic light | #FFFDEE | warm white, additive |

Motion: the water should feel like a still image that happens to be alive. Cells drift and reshape over roughly 15 to 30 seconds; nothing moves fast enough to draw the eye away from the calendar.

## Architecture

One `<canvas>` at `z-index: 0` draws the water (sticky inside the scrolling content, see "Rubber band" below; it was `position: fixed` before 2026-09); the whole UI sits above it at `z-index: 10` in a normal DOM layer. The canvas never receives pointer events and is `aria-hidden`.

```text
<main class="app">
  <div class="water-track">      position: absolute; top: -100px; bottom: 0 (inside #root, display: flow-root)
    <WaterBackground ... />      position: sticky; top: -100px; height: calc(100vh + 100px); z-index: 0
  <div class="ui">               position: relative; z-index: 10
    <TopNavigation />
    <Calendar data-water-quiet /> registers its rect as a quiet zone
    <AgentCard data-water-quiet />
  </div>
</main>
```

Rendering rules:

- Raw WebGL 1 context: `canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })`. No WebGL 2 features are needed.
- Full-screen coverage comes from a single clip-space triangle `[-1,-1, 3,-1, -1,3]` with a two-line vertex shader. There is no camera, no PlaneGeometry and no aspect-ratio dependence.
- All geometry-free: the fragment shader computes everything from `gl_FragCoord`.
- The shader source lives in `water.frag.glsl` and is imported as a string (Vite: `?raw`; other bundlers: equivalent raw loader). Do not inline it into TSX, so the SkSL port later can diff against one file.
- UI containers above the water use solid translucent fills (for example `rgba(255,253,246,0.8)` with a 1px white border). Never `backdrop-filter`: the canvas repaints every frame, so a blur backdrop forces a full re-composite per frame and kills the frame budget on Safari.

File layout (adjust paths to the repo's convention):

| File | Purpose |
| --- | --- |
| `src/background/water.frag.glsl` | fragment shader, verbatim from this spec |
| `src/background/WaterBackground.tsx` | canvas, GL setup, uniforms, frame loop, resize, visibility, reduced motion |
| `src/background/useQuietZones.ts` | collects rects of `[data-water-quiet]` elements via `ResizeObserver` and scroll/resize events |
| `src/background/waterDefaults.ts` | the default parameter object (values in the uniform table) |

## Component API and quiet zones

`WaterBackground` takes a partial `WaterParams` object; missing keys fall back to `waterDefaults`. Every value maps 1:1 to a shader uniform.

```ts
export type WaterParams = {
  speed: number;    // time multiplier, 1 = as tuned
  scale: number;    // caustic cells per viewport height
  caustic: number;  // caustic brightness
  refraction: number;
  tint: number;     // 0 = soda blue, 1 = melon
  quiet: number;    // 0 = ignore UI rects, 1 = fully calm under them
  glass: number;    // liquid glass lens strength under data-water-glass surfaces (0 = off)
  maxDpr: number;   // device pixel ratio cap
};

export const waterDefaults: WaterParams = {
  speed: 1, scale: 4.5, caustic: 0.5, refraction: 0.012,
  tint: 0.5, quiet: 0.85, glass: 1, maxDpr: 1.25,
};

type Props = { params?: Partial<WaterParams>; paused?: boolean; className?: string };
```

Quiet zone contract:

- Any element with the attribute `data-water-quiet` registers its bounding rect as a quiet zone. The calendar and floating cards get it; the top bar does not need it.
- `useQuietZones()` observes those elements with one `ResizeObserver` plus `scroll` and `resize` listeners (passive), and returns up to 4 rects in device pixels with a bottom-left origin: `x = rect.left * dpr`, `y = (viewportHeight - rect.bottom) * dpr`, `w = rect.width * dpr`, `h = rect.height * dpr`. (Superseded 2026-09: rects are measured relative to the canvas's own box via `canvasFrame()`; see "Tracking rules". Never use `innerHeight`: with always-visible scrollbars it includes the scrollbar and every rect lands one scrollbar height too high.) Elements appearing or disappearing (route change, modal) must re-run the query; a `MutationObserver` on the UI root or an explicit `registerQuietZone(el)` helper are both acceptable.
- More than 4 candidates: keep the 4 largest by area. The shader unions the rects with a soft edge of 12% of the viewport height, so adjacent cards merge into one calm region.
- The quiet mask does not darken the water. It lowers caustic contrast and refraction motion so text above stays readable without the background looking dirty.

Rect uniforms are uploaded once per frame only when the values changed since the last frame; compare the flattened `Float32Array` before calling `uniform4fv`.

Rubber band (added 2026-09): macOS elastic overscroll at the top / bottom edge translates the scrolling content on the compositor and leaves `position: fixed` elements in place. No JS value reports that offset, so a fixed canvas cannot follow it, and the glass light / rim stayed behind while the DOM frames bounced. The canvas therefore lives in the scrolling content: an absolutely positioned `.water-track` (from 100px above the document top to its bottom) holds a `position: sticky; top: -100px` host, `100vh + 100px` tall. During normal scrolling it behaves like a fixed layer; during a bounce it moves with the content, so glass and frames stay together in any browser. The 100px overscan above the top hides the gap when pulling down at the top. Overflow above the document top adds no scroll height, but overflow below would, so there is no overscan at the bottom (a bottom bounce briefly shows the page background colour). `#root` is `display: flow-root` so the top bar's margin does not collapse through it and shift the track. The canvas resolution comes from the host's own box, not the viewport.

Tracking rules (revised 2026-09 after glass surfaces drifted off their DOM frames):

- Coordinates are relative to the canvas's own box, not the viewport: `x = (r.left - canvasBox.left) * scale`, `y = (canvasBox.bottom - r.bottom) * scale`, `scale = canvas.height / canvasBox.height` (`canvasFrame()`). Never assume `innerHeight` or `dpr`.
- While animating, the draw loop re-measures every quiet / glass rect right before each draw (at most 10 elements; the element lists are cached and refreshed only by the `MutationObserver`). Any DOM movement, including ones that fire no event (Web Animations, sticky, elastic scroll, HMR), is picked up on the next frame. The event-driven recompute remains for the still (reduced-motion) mode.
- Waking the loop must never cancel an already scheduled frame. Rect changes can arrive every frame (a moving droplet, hover tilt writing `style`); cancel-and-reschedule then starves the draw callback forever and the canvas freezes with stale glass while the DOM moves on.
- Animate moving glass with a main-thread property (`left`, `width`), not a compositor-only `transform`: if the main thread stalls (lazy route load), the compositor would keep moving the DOM while the canvas cannot redraw.
- `?glass-debug` overlays the rects read back from the GPU (`gl.getUniform`) in cyan over the DOM frames in red, with viewport / canvas / scroll numbers, for diagnosing drift on a real machine.

### Glass lens (added 2026-09, Home liquid glass)

Surfaces that should read as liquid glass (the global nav and the four Home portal cards) carry `data-water-glass`. The shader treats each one as a convex lens over the water, so the refraction is real and costs one extra SDF loop per pixel, not a second `renderB` call.

- The collector (`collectGlassRects`) returns up to 6 rotated rounded rects in device pixels: centre (bbox centre, bottom-left origin), layout size (`offsetWidth/Height`, so a rotated card is not inflated to its bbox), corner radius (clamped to half the short side), and the CSS rotation angle read from the computed transform (`atan2(b, a)`, clockwise positive). The same `ResizeObserver` / `MutationObserver` loop as the quiet zones tracks them; pointer tilt writes `style`, which the mutation observer already watches.
- Optics follow Apple's Liquid Glass (WWDC25 "Meet Liquid Glass": lensing rather than scattering). The bevel has a convex squircle profile `y = (1 - (1 - x)^4)^(1/4)` (`x = 0` at the edge, bevel width = `min(half short side, 6% of viewport height)`), so its slope, and therefore the Snell refraction toward the centre, is steep at the rim and zero on the flat middle. The middle magnifies by `3.5% × lens`.
- Two variants, chosen by the attribute value and packed into `uGlassMeta[i] = (radius, angle, lens, frost)`: `clear` (lens 1.5, frost 0.3: the middle stays see-through, used by the top bar and its selection droplet) and `regular` (lens 1, frost 1: caustic lines soften 16 → 6, sparkles and sand grain drop out, used by the Home portal cards). Empty means `regular`. Surfaces with `opacity: 0` are skipped.
- The rim is lit from `uLight`: `0.3 + 0.7·max(n·L, 0) + 0.35·max(-n·L, 0)²` (bright on the light side, a weaker internal reflection opposite), a crisp 3px band plus a soft 12px band. `WaterBackground` eases `uLight` toward the pointer direction (viewport centre → pointer), the web stand-in for the iPhone gyroscope; it stays at the top-left `(-0.6, 0.8)` under reduced motion and on touch devices. CSS uses the same direction for its conic rim (`--glass-light-angle`, written on `<html>` by `useGlassLight`).
- On the bevel band only (`bevel > 0.02`) red and blue are re-sampled at 0.92× / 1.08× of the refraction offset for a slight chromatic dispersion; the rest of the screen still costs one `renderB` per pixel. Glass also lifts saturation by 1.25×.
- Moving glass (the top bar's selection droplet, animated with the Web Animations API, which does not touch the `style` attribute) calls `requestGlassTracking(ms)`; the collector then re-measures every animation frame for that long.
- With `uGlassCount = 0` or `glass = 0` the output is identical to the original shader.
- CSS on the glass element only adds a thin tint, a 1px gradient rim, and a pointer-following specular (`src/ui/glass.css`). It still never uses `backdrop-filter` while the canvas is running. `WaterBackground` sets `<html data-water="webgl | fallback">`; only in `fallback` (no canvas, static background, so no per-frame re-composite) does CSS blur with `backdrop-filter`.

## Shader

The fragment shader below is final and compiled and rendered as-is under WebGL 1. Copy it byte for byte into `water.frag.glsl`; do not reformat, rename uniforms, or "improve" the noise. If a visual change is wanted, change the uniform defaults first. (Revised 2026-09 to add the glass lens; the water itself is unchanged when no glass surface is registered.)

Uniforms (set every frame unless noted):

| Uniform | Type | Source | Default |
| --- | --- | --- | --- |
| `uRes` | vec2 | canvas width, height in device pixels | on resize |
| `uTime` | float | accumulated seconds times `speed` | 0 at mount |
| `uQuietRects[0]` | vec4[4] | quiet zone rects, device px, bottom-left origin | zeros |
| `uQuietCount` | int | number of rects in use, 0 to 4 | 0 |
| `uScale` | float | `scale` | 4.5 |
| `uCaustic` | float | `caustic` | 0.5 |
| `uRefr` | float | `refraction` | 0.012 |
| `uTint` | float | `tint` | 0.5 |
| `uQuiet` | float | `quiet` | 0.85 |
| `uGlassRects[0]` | vec4[6] | glass surfaces: centre x, y (device px, bottom-left origin), w, h | zeros |
| `uGlassMeta[0]` | vec4[6] | corner radius (device px), rotation (rad, CSS clockwise), lens, frost | zeros |
| `uGlassCount` | int | number of glass surfaces in use, 0 to 6 | 0 |
| `uGlass` | float | `glass` | 1 |
| `uLight` | vec2 | specular light direction, screen space y up (pointer-driven) | (-0.6, 0.8) |

Get the array location with `gl.getUniformLocation(prog, 'uQuietRects[0]')` and upload with `gl.uniform4fv(loc, new Float32Array(16))`. The bare name `uQuietRects` returns null on some implementations.

Vertex shader (the only geometry):

```glsl
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
```

Fragment shader, `water.frag.glsl`:

```glsl
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
uniform int   uGlassCount;    // how many of uGlassRects are in use (0..6)
uniform float uGlass;         // liquid glass lens strength (0 = off)
uniform vec2  uLight;         // specular light direction (screen space, y up)

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
  cp += 0.2 * vec2(gnoise(cp * 0.9 + t * 0.08), gnoise(cp * 0.9 + 5.1 - t * 0.08));
  vec2 dir = normalize(grad + vec2(1e-4));
  vec3 c = causticsRGB(cp, dir, t, mix(16.0, 6.0, frost), 0.014 + 0.05 * bevel);
  float shallow = mix(1.0, 0.55, clamp(d / 1.3, 0.0, 1.0));
  c *= shallow * uCaustic;
  c = mix(c, vec3(0.06 * uCaustic), quiet);
  col += c * vec3(1.0, 0.99, 0.93);

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
void glassLens(vec2 frag, out vec2 off, out float rim, out float frost, out float bevel, out float body) {
  off = vec2(0.0);
  rim = 0.0;
  frost = 0.0;
  bevel = 0.0;
  body = 0.0;
  vec2 L = normalize(uLight + vec2(1e-5));
  for (int i = 0; i < 6; i++) {
    if (i >= uGlassCount) break;
    vec4 g = uGlassRects[i];
    vec4 meta = uGlassMeta[i];
    float cs = cos(meta.y);
    float sn = sin(meta.y);
    vec2 d = frag - g.xy;
    vec2 lp = mat2(cs, sn, -sn, cs) * d; // screen -> element space (undo the CSS rotation)
    vec2 hb = g.zw * 0.5;
    float sd = sdRoundBox(lp, hb, meta.x);
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
    float light = 0.3 + 0.7 * max(nl, 0.0) + 0.35 * pow(max(-nl, 0.0), 2.0);
    float band = (1.0 - smoothstep(0.0, 3.0, e)) + 0.35 * (1.0 - smoothstep(0.0, 12.0, e));
    rim = max(rim, inside * band * light * uGlass);
    frost = max(frost, inside * meta.w * uGlass);
    bevel = max(bevel, inside * slope * uGlass);
    body = max(body, inside * uGlass);
  }
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 goff;
  float rim, frost, bevel, body;
  glassLens(frag, goff, rim, frost, bevel, body);
  float quiet = quietMask(frag) * uQuiet;
  vec3 col = renderB(frag + goff, uTime, quiet, frost, bevel);
  if (bevel > 0.02) {
    // chromatic dispersion on the bevel: red bends a little less, blue a little more
    col.r = renderB(frag + goff * 0.92, uTime, quiet, frost, bevel).r;
    col.b = renderB(frag + goff * 1.08, uTime, quiet, frost, bevel).b;
  }
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.0 + 0.25 * body); // glass lifts saturation
  col = mix(col, col * 1.03 + 0.035, frost * 0.6); // milky body (regular glass)
  col += bevel * 0.04 + rim * 0.5;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
```

## Runtime rules

Frame loop:

- One `requestAnimationFrame` loop owned by the component; cancel it on unmount and release the GL context with `WEBGL_lose_context` if available.
- Time accumulates as `t += min(dt, 0.1) * speed`, so changing `speed` never jumps the animation and a long frame stall does not skip ahead.
- Skip the draw entirely (keep the loop idle) when `document.visibilityState === 'hidden'`, when `paused` is true, or when the canvas is fully covered by an opaque overlay the app controls (optional prop later).
- On `resize`, set `canvas.width/height = clientWidth/clientHeight * dpr` (of `document.documentElement`, i.e. the viewport minus scrollbars) where `dpr = min(devicePixelRatio, maxDpr)`, call `gl.viewport`, and re-upload `uRes`. Scrollbars can appear or disappear without a `resize` event, so also watch the canvas host with a `ResizeObserver` (both the canvas size and the quiet / glass rects). Debounce is unnecessary; the draw is cheap.

Quality:

- `maxDpr` defaults to 1.25. The image is soft by nature, so 2x rendering buys nothing visible and doubles the fragment cost. On a 4K display the 1.25 cap still renders about 3.1 million fragments per frame, which is within budget for this shader on an integrated GPU.
- Target 60 fps on Apple Silicon and recent Intel integrated graphics. If profiling shows the frame over 8 ms, lower `maxDpr` to 1.0 before touching the shader.

Reduced motion:

- If `matchMedia('(prefers-reduced-motion: reduce)')` matches, render one frame at a fixed `uTime` (12.0 looks good) and stop the loop. Re-evaluate on the media query's `change` event.

Context loss:

- Handle `webglcontextlost` (call `preventDefault`, stop the loop) and `webglcontextrestored` (rebuild program and buffer, resume). Without this, sleeping the laptop can leave the background blank.

Fallback:

- If `getContext('webgl')` returns null or the shader fails to compile, render nothing and let the page background colour `#CDEEE3` show. Log the compile info to the console in development only.

## Acceptance criteria

- [ ] With no props, the background matches side B of the reference demo at its defaults: rounded caustic cells about 1/5 of the viewport height, mint liquid, sand visible in lighter patches, sparse bubbles.
- [ ] Nothing in the scene completes a visible cycle in under 15 seconds; the cell network reshapes, it does not scroll.
- [ ] Resizing the window from 16:9 to 4:3 to a tall narrow window keeps the cells round; no stretching, no bands at the edges.
- [ ] With `data-water-quiet` on the calendar card, the region under it shows clearly fewer caustic lines and less refraction than the surroundings, and the card's 13px body text stays readable at its default 80% white fill.
- [ ] Switching tabs stops the draw loop (verify with the Performance panel: zero GPU work while hidden). Returning resumes without a time jump.
- [ ] With `prefers-reduced-motion: reduce` the background is a single still frame.
- [ ] Frame time under 8 ms at 1440p on an M-series MacBook and under 12 ms on Intel Iris Xe, measured with the calendar mounted.
- [ ] No `backdrop-filter` anywhere above the canvas. No three.js or other 3D dependency added to the bundle. (The glass fallback blur applies only when there is no canvas.)
- [ ] Under a `data-water-glass` card the water visibly bends at the edges and the caustic lines soften; rotated portal cards get a lens that follows their rotation.
- [ ] `water.frag.glsl` is byte-identical to this spec. Tuning is done through `waterDefaults` only.

Pitfalls to avoid (each of these was tried and rejected during prototyping):

- Caustics from thresholded fbm (`smoothstep(a, b, fbm + fbm)`) produce cloud-like blobs, not a cell network. Keep the Voronoi edge method.
- Mixing sand, soda and melon by screen `uv.x` / `uv.y` reads as a gradient wallpaper. Depth-based absorption is what makes it look like liquid over sand.
- `smoothstep(edge0, edge1, x)` with `edge0 > edge1` is undefined in GLSL ES and behaves differently across GPUs. Always write `1.0 - smoothstep(edge1, edge0, x)`.
- Screen-space `uv` without aspect correction stretches the cells on wide displays. Every pattern in the shader uses `p = (frag - 0.5 * uRes) / uRes.y`.
- Large sums of `sin()` waves look like directional stripes. The height field is fbm with domain warping and only a small sin term inside the Voronoi animation.
- Bubbles as DOM elements with `backdrop-filter` are far more expensive than the whole shader. They are drawn in the shader.
- Do not request the array uniform by its bare name; use `uQuietRects[0]`.

## 日本語の要約と判断ポイント

この仕様書は、Seasonals のWeb版(macOS / Windows のブラウザ)向けに、試作で選んだB案の背景をそのまま実装させるためのものです。Claude Code にはこのファイル全体を渡してください。シェーダーは完成品として上に貼ってあるので、実装の中身は「Reactコンポーネントへの組み込み」「quiet zoneの配線」「停止・縮小・reduced motionなどの運用ルール」に絞られます。

判断ポイント:

- three.js や React Three Fiber は使いません。全画面の三角形1枚と生のWebGL 1だけで十分で、後で Expo 向けに SkSL へ移植するときも同じGLSLファイルを差分の基準にできます。
- シェーダーは1バイトも変えない前提です。見た目を調整したいときは `waterDefaults` の値だけを動かします。
- UIの下を落ち着かせる仕組みは `data-water-quiet` 属性で登録します。暗くするのではなく、光の網目のコントラストと屈折の動きを下げる方式です。
- UIカードに `backdrop-filter` は使いません。背景が毎フレーム描き換わるので、ぼかしは毎回再合成になり、特にSafariで重くなります。
- (2026-09 追加) Home の top bar と四隅のカードは `data-water-glass` で「液体ガラス」にします。屈折・すりガラス感・縁の光はシェーダーが GPU で描き、CSS は薄い色と光沢の縁だけです。WebGL が使えない時だけ、背景が静止しているので CSS の `backdrop-filter` で代替します。
- 解像度は devicePixelRatio を1.25で頭打ちにします。このぼんやりした絵では2倍描画の恩恵がなく、GPU負荷だけ倍になります。

未確認の前提:

- Web版のスタックを React + TypeScript(Vite想定)として書いています。Expo web の場合はシェーダーの読み込み方法(`?raw`)だけ差し替えが必要です。
