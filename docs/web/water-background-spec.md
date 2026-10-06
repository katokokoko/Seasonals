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

Updated 2026-10-05 (tuned against a photo of shallow sea water seen straight down, `docs/web/reference/water-*.md`; the photo itself is local-only):

1. Caustics: a network of rounded cells, a multiplicatively weighted Voronoi diagram (each site's distance scaled by its own weight, so every wall is a circular arc and the cells bow like pebbles of varied size), domain-warped so the walls curve and stretched along the flow into lobes. Each wall is a warm-cream line with a crisp near-white core, a tight glow, and a width that swells near the knots where walls meet (the brightest points) and thins between them. The light is conserved: cell interiors sit a little deeper and more aqua (never greyer). No colour fringe in open water; only a glass bevel splits colour. This is the element that reads as water.
2. Liquid colour: the water absorbs red first (then blue for soda, green for melon), growing with depth squared, so shallow water keeps the pale vanilla sand (≈ #FAF7EA in the light, the app's vanilla) and deep water goes turquoise-teal, plus a thin turquoise in-scatter where deep. Depth comes in patches, a little deeper toward the top; under UI the depth pattern is softened but kept, so the vanilla shallows still show.
3. Sand: pale vanilla cream with soft patches, faint ripple marks, a visible fine grain (smooth noise, finest octave about 3 canvas px, so it stays fine when the DPR ≤ 1.25 canvas is stretched on Retina), and sparse small specks (pebble and pale shell). Grain and specks follow the refraction only loosely, so the ripple train never stretches them into streaks.
4. Surface: the view of the bottom wobbles with the swell and a train of small ripples; the ripples show as a few long, thin strands curving along the flow (zero lines of a noise field squeezed across the flow, shown only where a sparse bundle mask allows) and kink the caustic lines where they cross. Small crisp four-point glints sit on the caustic knots (each glint cell maps its centre into the caustic space and lights only near a knot) and twinkle; a soft dot at bright crossings and tiny sparse bubbles.
5. Quiet zones keep blurred lines and the same colour, slightly lighter, so the calm still reads as the same water. A soft highlight shoulder keeps wide bright patches from blowing out.

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

Two canvases draw the background (see "Rubber band" below): a `position: fixed` water layer at `z-index: 0`, and a transparent glass layer that lives in the scrolling content and draws only inside the glass surfaces; the whole UI sits above it at `z-index: 10` in a normal DOM layer. The canvas never receives pointer events and is `aria-hidden`.

```text
<main class="app">
  <WaterBackground ... />        water layer: position: fixed; inset: 0; z-index: 0
    .water-track                 position: absolute; inset: 0; z-index: 1 (inside #root, display: flow-root)
      .glass-canvas              glass layer: position: sticky; top: 0; height: 100vh (uGlassOnly = 1)
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
  maxFps: number;   // draw rate cap, 0 = the display rate (added 2026-10-06, heat)
  animate: boolean; // false = hold a still frame (added 2026-10-06, heat)
};

export const waterDefaults: WaterParams = {
  speed: 1, scale: 4.5, caustic: 0.5, refraction: 0.012,
  tint: 0.5, quiet: 0.6, glass: 1, maxDpr: 1.25,
  maxFps: 30, animate: true,
};
// work screens: waterCalm = { ...waterDefaults, speed: 0.6, caustic: 0.28, refraction: 0.008, quiet: 1, glass: 0.7, animate: false }

type Props = { params?: Partial<WaterParams>; paused?: boolean; className?: string };
```

Quiet zone contract:

- Any element with the attribute `data-water-quiet` registers its bounding rect as a quiet zone. The calendar and floating cards get it; the top bar does not need it.
- `useQuietZones()` observes those elements with one `ResizeObserver` plus `scroll` and `resize` listeners (passive), and returns up to 4 rects in device pixels with a bottom-left origin: `x = rect.left * dpr`, `y = (viewportHeight - rect.bottom) * dpr`, `w = rect.width * dpr`, `h = rect.height * dpr`. (Superseded 2026-09: rects are measured relative to the canvas's own box via `canvasFrame()`; see "Tracking rules". Never use `innerHeight`: with always-visible scrollbars it includes the scrollbar and every rect lands one scrollbar height too high.) Elements appearing or disappearing (route change, modal) must re-run the query; a `MutationObserver` on the UI root or an explicit `registerQuietZone(el)` helper are both acceptable.
- More than 4 candidates: keep the 4 largest by area. The shader unions the rects with a soft edge of 12% of the viewport height, so adjacent cards merge into one calm region.
- The quiet mask does not darken the water. It lowers caustic contrast and refraction motion so text above stays readable without the background looking dirty.
- (2026-10-06) Home uses `quiet` 0.6 (0.4 was tried first): at 0.85 the column-unioned quiet zones covered most of the lobby and read as a pale mint film. The calendar card is opaque and the portal cards carry a vanilla ellipse under their text, so they stay readable. Under regular / clear glass (the top bar) the shader keeps the old calm: `quiet = max(mask * uQuiet, mask * body * 0.85)`.

Rect uniforms are uploaded once per frame only when the values changed since the last frame; compare the flattened `Float32Array` before calling `uniform4fv`.

Rubber band (added 2026-09): macOS elastic overscroll at the top / bottom edge translates the scrolling content on the compositor and leaves `position: fixed` elements in place. No JS value reports that offset. With glass drawn into the fixed water canvas, the glass light / rim stayed behind while the DOM frames bounced; moving the whole water canvas into the scrolling content instead fixed that but exposed a band of page background at the stretched edge. So the background is split into two layers:

- Water layer: `position: fixed`, `uGlassCount = 0`. It never moves, so a bounce never reveals a band.
- Glass layer: a transparent canvas (`alpha: true`, premultiplied) inside `.water-track`, `position: sticky; top: 0; height: 100vh`, drawn with `uGlassOnly = 1`: outside every glass surface the fragment returns `vec4(0)` right after the cheap SDF loop, inside it renders the refracted water + rim with alpha = coverage. It moves with the scrolling content, so glass and frames stay together. The water under the lens comes from the same `uTime` / coordinates, so it is seamless except during a bounce, when the glass carries its refracted water along (reads as glass moving over water).
- The quiet zones are uploaded to both layers, each measured against its own canvas box. If the glass context cannot be created, the water layer draws the glass as before.
- `#root` is `display: flow-root` so the top bar's margin does not collapse through it and shift the track. The skip link is hidden with `clip-path` until focused (a top bounce would otherwise expose it above the page).

Floaters (added 2026-09): Home shows two characters drifting on the water (`src/home/FloatingFriends.tsx`, decorative, `aria-hidden`). They live in a `position: fixed; z-index: 0` layer after the water canvas (above the water, below the glass layer and the UI) and live a slow cycle (`src/home/friendsMotion.ts`): surface in the open water of the left / right columns between the portal cards (measured every frame, avoiding the zone the other one is in), drift with a slow curving current (5–11 px/s, a ~5 s bob, ±5° roll) for 20–40 s (they may float under a card or off screen), sink and fade, then reappear elsewhere after 5–12 s. The pointer does not scare them: moving it nearby stirs the water and pushes them slowly with inertia, which fades over a few seconds. Under reduced motion they rest still in the middle of the open water. Each carries `data-water-floater`; the tracker packs up to 2 of them (`collectFloaters`, relative to the canvas box, skipped at opacity 0) into `uFloaters`. The shader adds outward ripple rings around each (they bend the caustics and their crests catch the light, so they read even over quiet zones) and a soft shadow on the sand shifted down-right by the depth, which also blocks the caustics. With no floaters the output is unchanged. The images are 360 px WebP made once with `scripts/optimize-characters.mjs` (headless Chrome: trim transparent margins, resize, encode).

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
- Three variants, chosen by the attribute value and packed into `uGlassMeta[i] = (radius, angle, lens, frost)`: `clear` (lens 1.5, frost 0.3: the middle stays see-through, used by the top bar and its selection droplet), `regular` (lens 1, frost 1: caustic lines soften 16 → 6, sparkles and sand grain drop out) and `droplet` (lens 1.2, frost 0, see below; used by the Home portal cards). Empty means `regular`. Surfaces with `opacity: 0` are skipped.
- Droplet (added 2026-10, Home portal cards as water blobs): `uGlassShape[i] = (wobble, droplet 0/1, seed, 0)`. The rounded box's outline breathes by `DROPLET_WOBBLE_PX` (4 CSS px) along its perimeter (two sines of the element-space angle, > 15 s cycles, still under reduced motion). The body is a window into the water: the water under it is sampled a little less calmed (quiet × 0.6) and its contrast is deepened between the lines (crossings never blow out to white), with a thin aqua tint toward the rim only, so the middle stays clear. No frost, no saturation lift, no bevel dispersion. The rim is a single crisp ~2 px light line, brightest where it faces `uLight`, with a faint internal reflection opposite, and a small four-point sparkle sits just inside the rim on the side facing the light. The droplet also casts a light pool: the water layer receives only the droplet rects (`uGlassLens = 0`: no lens there) and draws, outside each card, a bright band on the sand along the edges away from the light with a faint aqua shade beyond; there is no grey drop shadow. While WebGL runs, CSS removes the droplet's tint, rim ring, specular and box shadow (`.glass-droplet` in `src/ui/glass.css`) so no rectangular CSS edge fights the moving outline; text legibility comes from a soft vanilla ellipse that fades before the edges and the clear glass's text halo. Without WebGL, or with reduced transparency, the cards fall back to the regular glass look. The sparkle is where a ray from the centre toward the light (stretched by the half size, so a diagonal light reaches the corner of a wide card) meets the rounded outline, pulled in by 22 % of the short half side; it glides along the rim as `uLight` eases after the pointer and never jumps between corners. With the default top-left light it rests near the top-left corner.
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
| `uQuiet` | float | `quiet` | 0.6 (Home; 0.4 was tried first; 0.85 until 2026-10-06, which made the column-unioned quiet zones read as a pale mint film over the whole Home. Work screens use the calm preset, quiet 1) |
| `uGlassRects[0]` | vec4[6] | glass surfaces: centre x, y (device px, bottom-left origin), w, h | zeros |
| `uGlassMeta[0]` | vec4[6] | corner radius (device px), rotation (rad, CSS clockwise), lens, frost | zeros |
| `uGlassShape[0]` | vec4[6] | droplet outline wobble (device px), droplet 0/1, wobble seed, unused | zeros |
| `uGlassCount` | int | number of glass surfaces in use, 0 to 6 | 0 |
| `uGlassLens` | float | 1 = draw the glass lenses (glass layer, or the water layer when there is no glass layer); 0 = only the droplets' light pools (water layer) | 1 |
| `uGlass` | float | `glass` | 1 |
| `uLight` | vec2 | specular light direction, screen space y up (pointer-driven) | (-0.6, 0.8) |
| `uGlassOnly` | float | 1 on the glass layer (transparent outside glass), 0 on the water layer | 0 |
| `uFloaters[0]` | vec4[2] | floaters: centre x, y (device px, bottom-left origin), body radius (device px), strength | zeros |
| `uFloaterCount` | int | number of floaters in use, 0 to 2 | 0 |

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
// The bottom (sand grain, specks, ripple marks) is lit by a network of rounded caustic cells:
// the light is conserved, so the walls are bright and the band just beside them a little
// deeper. The water absorbs red most with depth (mint to teal).
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
// Caustics: a network of rounded cells. The cells are a multiplicatively weighted Voronoi diagram (each
// site's distance is scaled by its own weight), so every wall is a circular arc and the cells bow like
// pebbles of varied size, not straight-edged tiles. The walls are where the swell focuses the sunlight:
// a crisp core with a tight glow, brightest at the knots where walls meet. x: distance to the nearest
// wall, y: to the nearest knot
vec2 cellWalls(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float F1 = 8.0, F2 = 8.0, F3 = 8.0;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 h = hash22(n + g);
    vec2 o = 0.5 + 0.42 * sin(t + 6.2831 * h);
    float d = length(g + o - f) * (0.75 + 0.5 * h.x); // multiplicatively weighted: every wall is a circular arc, cells bow like pebbles
    if (d < F1) { F3 = F2; F2 = F1; F1 = d; } else if (d < F2) { F3 = F2; F2 = d; } else if (d < F3) { F3 = d; }
  }
  return vec2(F2 - F1, F3 - F1);
}
// rgb: the caustic light, a: the band just beside the walls (the light there was pulled into the wall,
// so it sits a little deeper and more aqua). sharp = 16 is the tuned line; glass frost and quiet zones
// lower it so the lines read as blurred. Colour split only on a glass bevel (open water stays cream)
vec4 causticsRGB(vec2 cp, vec2 dir, float t, float sharp, float spread) {
  vec2 eg = cellWalls(cp, t * 0.35);
  vec3 e = vec3(eg.x);
  if (spread > 0.002) e = vec3(cellWalls(cp - dir * spread, t * 0.35).x, eg.x, cellWalls(cp + dir * spread, t * 0.35).x);
  float taper = mix(0.4, 1.7, smoothstep(0.0, 0.55, eg.y)); // thick near the knots, hair-thin between
  vec3 c = 0.75 * exp(-e * sharp * taper) + 0.03 * exp(-e * sharp * 0.3);
  c += 0.7 * exp(-e * sharp * taper * 3.5); // a crisp near-white core inside each line
  c += 1.3 * exp(-eg.y * max(sharp, 10.0) * 1.8); // the knots where walls meet are the brightest
  c += 1.6 * exp(-eg.y * 40.0 * min(sharp / 16.0, 1.0)); // with a small hot spot right at the knot
  float band = smoothstep(0.08, 0.45, eg.x); // the cell interior: the light was pulled out of it into the walls
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
  // ripples: the zero lines of a noise field squeezed across the swell are long, thin, wavy
  // strands running with it. They come in bundles and wobble the view of the bottom
  vec2 nf = vec2(-FLOW.y, FLOW.x);
  float bend = fbm3(p * 0.8 + vec2(t * 0.02, -t * 0.015)) + 0.35 * gnoise(p * 3.2 + vec2(-t * 0.03, t * 0.02));
  vec2 sq = vec2(dot(p, nf) * 16.0 + bend * 13.0, dot(p, FLOW) * 1.3 - t * 0.05); // long along the flow
  float sn = gnoise(sq) + 0.4 * gnoise(sq * vec2(1.9, 1.1) + 3.3);
  float bundle = smoothstep(-0.2, 0.26, fbm3(p * 1.4 + 4.0 + vec2(-t * 0.012, t * 0.01)));
  vec2 off = -grad * uRefr * motion + nf * (sn * 0.004 * bundle * motion);
  vec2 rip;
  float shade, glint;
  floaterField(frag, t, rip, shade, glint);
  off += rip;

  // depth (low frequency, drifts very slowly; a little deeper toward the top)
  // shallow sand patches and deeper aqua patches, like the photo (not one even tint)
  float d = 0.05 + 1.0 * smoothstep(-0.14, 0.36, fbm3(p * 0.7 + vec2(3.1, 1.7) + t * 0.006) + 0.22 * dot(p, vec2(-0.35, 0.95)));
  float dv = mix(0.5, d, mix(1.0, 0.55, quiet)); // calmer depth changes under UI (the vanilla shallows still show)

  // sand bottom, sampled through the refraction: patches, ripple marks, grain, specks
  vec2 sp = p + off;
  float patches = fbm(sp * 1.6 + 11.0);
  // pale vanilla cream sand (the app's vanilla, ≈ #FAF7EA in the light), never grey-beige
  vec3 sand = mix(vec3(0.975, 0.94, 0.83), vec3(1.0, 0.98, 0.91), mix(smoothstep(-0.3, 0.35, patches), 0.6, 0.6 * quiet));
  sand *= 1.0 + 0.02 * calm * (1.0 - bevel) * sin(dot(sp, vec2(0.45, 0.89)) * 70.0 + 4.0 * patches); // faint ripple marks (a glass rim would bend them into rings)
  // grain and specks follow the bottom only loosely: the ripple train's refraction would stretch
  // anything this fine into hair-like streaks. The grain is smooth noise with its finest octave about
  // 3 canvas px across (no square per-pixel blocks, which turn coarse when the canvas, drawn at
  // DPR <= 1.25, is stretched onto a Retina screen). Where glass bends the view hard (its rim) the
  // grain fades, so the lens never smears it into swirls
  vec2 gp0 = p + off * 0.25;
  float grain = (gnoise(gp0 * 210.0) + 0.6 * gnoise(gp0 * uRes.y * 0.33 + 7.7)) * (1.0 - 0.7 * frost) * (1.0 - 0.8 * bevel) * mix(1.0, 0.3, quiet);
  sand += grain * 0.1;
  vec2 gp = gp0 * 150.0;
  vec2 gi = floor(gp);
  float hs = hash21(gi + 5.0);
  if (hs > 0.9) {
    float sd = length(fract(gp) - 0.5 - (hash22(gi) - 0.5) * 0.5);
    float sk = (1.0 - smoothstep(0.1, 0.28, sd)) * mix(0.7, 0.3, quiet) * (1.0 - 0.8 * bevel);
    sand = mix(sand, hs > 0.95 ? vec3(1.0, 0.985, 0.94) : sand * 0.84, sk); // more pale shell specks
  }

  // caustics
  vec2 cp = p * uScale * 1.35;
  cp += 0.85 * vec2(fbm3(p * 0.9 + t * 0.03), fbm3(p * 0.9 + 7.3 - t * 0.03)); // cells grow and shrink across the view
  cp += grad * 0.012 * uScale;
  cp += rip * 3.0 * uScale; // ripple rings bend the caustic network
  cp += nf * (sn * 0.12 * bundle * motion); // so do the surface ripples: the lines kink where a strand crosses
  // stretch the cells along the swell and let them wave across it
  float along = dot(cp, FLOW);
  float across = dot(cp, nf);
  cp = FLOW * along * 0.6 + nf * (across * 1.35 + 0.25 * sin(along * 0.8 + t * 0.05)); // lobes stretched and bent along the flow
  cp += 0.2 * vec2(gnoise(cp * 1.15 + 3.7 + t * 0.04), gnoise(cp * 1.15 + 8.2 - t * 0.04)); // every wall bends into a smooth curve
  vec2 dir = normalize(grad + vec2(1e-4));
  float width = mix(0.55, 1.4, gnoise(cp * 0.35 + 2.3) + 0.5) * mix(0.35, 2.4, gnoise(cp * 1.3 + 6.1) + 0.5); // line width swells and pinches along each wall (hairline to thick band)
  float sharp = mix(16.0, 6.0, frost) * width * mix(1.0, 0.4, quiet);
  vec4 cb = causticsRGB(cp, dir, t, sharp, 0.05 * bevel);
  vec3 c = cb.rgb;
  float shallow = mix(0.78, 0.55, clamp(d / 1.2, 0.0, 1.0));
  c *= shallow * uCaustic * mix(1.0, 1.25, gnoise(cp * 0.21 + 8.1) + 0.5);
  c = mix(c, vec3(0.2 * uCaustic), quiet * 0.8); // the calm still shows soft blurred lines
  c *= 1.0 - 0.7 * shade;   // the floater blocks the light that makes caustics

  // water: absorbs red most, then blue (soda) or green less (melon), with depth; a thin aqua in-scatter
  vec3 k = mix(vec3(0.62, 0.13, 0.07), vec3(0.56, 0.09, 0.14), uTint); // red goes first: turquoise, never grey
  vec3 bottom = sand * exp(-k * dv * (0.35 + 1.9 * dv)); // shallow water keeps the vanilla, deep goes teal
  // light on the bottom: conserved, so the band beside the walls sits a little deeper and more aqua
  // (not greyer) and the focused lines run to warm cream white (they saturate like the photo's,
  // added after the water's glow so they are never tinted cyan)
  bottom *= mix(vec3(1.0), vec3(0.8, 0.93, 0.95), cb.a * uCaustic * 2.0 * calm); // interiors sit deeper aqua
  vec3 col = bottom * 0.92;
  col *= 1.0 - 0.13 * shade; // the floater casts a soft shadow on the sand
  col += vec3(0.32, 0.74, 0.74) * (1.0 - exp(-dv * 0.9)) * 0.17; // the water body glows turquoise where deep
  col += c * 0.8 * mix(bottom, vec3(1.0, 0.97, 0.88), 0.95);
  col = mix(col, col * 1.04 + 0.025, quiet); // quiet zones sit a little lighter behind the UI
  // soft shoulder: wide bright patches keep their sand instead of blowing out (thin line cores still clip)
  float hiL = dot(col, vec3(0.299, 0.587, 0.114));
  col -= vec3(max(hiL - 0.88, 0.0) * 0.55);

  // surface: the ripple strands catch the light as thin flowing bright lines
  // a few long, thin, continuous strands that curve along the flow across several cells (sparse,
  // never a stack of evenly spaced contour lines or short hatch marks)
  float strand = exp(-abs(sn) * 15.0) * smoothstep(0.16, 0.4, bundle * 0.5 + fbm3(p * 1.4 + 4.0 + vec2(-t * 0.012, t * 0.01)));
  col += strand * 0.34 * clear * (1.0 - bevel) * vec3(1.0, 0.99, 0.94); // a glass rim would bend them into rings
  col += glint * 0.05;       // floater ripple crests catch the light

  // sparkles: a soft dot at bright crossings, and sparse twinkling four-point stars
  float cg = c.g;
  float tw = gnoise(p * 95.0 + vec2(t * 0.9, -t * 0.7)) * 0.5 + 0.5;
  col += pow(max(cg, 0.0), 3.0) * smoothstep(0.62, 0.9, tw) * 0.8 * clear;
  // small crisp glints at the caustic knots: each glint cell maps its centre into the caustic space
  // (local linear step through the scale and the flow stretch) and lights only near a knot
  vec2 si = floor(frag / 30.0);
  float sh = hash21(si + 71.0);
  if (sh > 0.5) {
    vec2 sc = (si + 0.2 + 0.6 * hash22(si + 3.0)) * 30.0;
    vec2 dpx = (sc - frag) / uRes.y * uScale * 1.35;
    vec2 kc = cellWalls(cp + FLOW * dot(dpx, FLOW) * 0.6 + nf * dot(dpx, nf) * 1.35, t * 0.35);
    float atKnot = exp(-kc.y * 12.0);
    float on = 0.4 + 0.6 * max(sin(t * (0.6 + sh) + sh * 40.0), 0.0);
    col += starGlint(frag - sc, 4.0 + 3.0 * hash21(si + 9.0)) * on * atKnot * 2.0 * clear * (1.0 - bevel);
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
  // quiet zones calm the water under UI by uQuiet; under regular / clear glass (the top bar) the water
  // stays as calm as 0.85, so its text keeps its contrast even when the lobby's uQuiet is low
  float qm = quietMask(frag);
  float quiet = max(qm * uQuiet, qm * body * 0.85);
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
```

## Runtime rules

Frame loop:

- One `requestAnimationFrame` loop owned by the component; cancel it on unmount and release the GL context with `WEBGL_lose_context` if available.
- Time accumulates as `t += min(dt, 0.1) * speed`, so changing `speed` never jumps the animation and a long frame stall does not skip ahead.
- Skip the draw entirely (keep the loop idle) when `document.visibilityState === 'hidden'`, when `paused` is true, or when the canvas is fully covered by an opaque overlay the app controls (optional prop later).
- (2026-10-06, heat) Draw at most `maxFps` (30) times a second. The rAF loop still runs at the display rate (120 Hz on ProMotion) but does nothing until `1000 / maxFps − 4` ms have passed since the last draw; a kick (quiet zone / glass moved, resize, preset change) draws at once so glass never lags its DOM frame. Before this, a MacBook Pro M4 Pro at 1440×900 CSS px drew both canvases about 70–100 times a second and the GPU never idled (rAF fell to 71 Hz on Home): the laptop ran hot.
- (2026-10-06, heat) `animate: false` (work screens) holds a still frame like reduced motion, but keeps `uTime` and the light where they are. The loop runs only while the preset eases in (time advances during the ease), then stops; quiet zone / resize changes draw one frame. `data-water-state` is `still`.
- (2026-10-06, heat) The glass layer draws only inside the union of the glass rects' rotated bounding boxes (`glassScissor()` in `quietZones.ts`, `gl.scissor`, pad 3 px + droplet wobble). Outside it the drawing buffer stays transparent.
- (2026-10-06, heat) The Home characters (`FloatingFriends`) update at 30 fps too, matching the water.
- The five heat measures can be toggled one by one on the dev server for comparison: `?water-perf=none | 1,3 | all | default` (`src/background/perfVariant.ts`, kept in sessionStorage, a small badge shows the active set). `e2e/water-power.mjs` measures each set on a visible Chrome window.
- On `resize`, set `canvas.width/height = clientWidth/clientHeight * dpr` (of `document.documentElement`, i.e. the viewport minus scrollbars) where `dpr = min(devicePixelRatio, maxDpr)`, call `gl.viewport`, and re-upload `uRes`. Scrollbars can appear or disappear without a `resize` event, so also watch the canvas host with a `ResizeObserver` (both the canvas size and the quiet / glass rects). Debounce is unnecessary; the draw is cheap.

Quality:

- `maxDpr` defaults to 1.25. The image is soft by nature, so 2x rendering buys nothing visible and doubles the fragment cost. On a 4K display the 1.25 cap still renders about 3.1 million fragments per frame, which is within budget for this shader on an integrated GPU.
- Target 60 fps on Apple Silicon and recent Intel integrated graphics. If profiling shows the frame over 8 ms, lower `maxDpr` to 1.0 before touching the shader. (Superseded 2026-10-06: the draw rate is capped at 30 fps, see "Frame loop". At 120 Hz uncapped the shader kept the GPU busy almost all the time.)

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
- [ ] Pulling past the top / bottom edge (macOS rubber band) moves glass light and rim with their frames and shows no band.
- [ ] No `backdrop-filter` anywhere above the canvas. No three.js or other 3D dependency added to the bundle. (The glass fallback blur applies only when there is no canvas.)
- [ ] Under a `data-water-glass` card the water visibly bends at the edges and the caustic lines soften; rotated portal cards get a lens that follows their rotation.
- [ ] The Home portal cards read as clear water drops: the water shows through with crisp lines, the outline breathes by a few px, a crisp light line and a small sparkle sit on the light side, and a light pool (no grey shadow) lies on the sand beside them; the card text stays readable.
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
