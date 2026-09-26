/**
 * WaterBackground — "Soda shallows" full-screen water (docs/web/water-background-spec.md)
 *
 * - raw WebGL 1、全画面 clip-space 三角形 1 枚、three.js / R3F 不使用
 * - shader は water.frag.glsl を `?raw` で読む (byte-identical、tuning は waterDefaults のみ)
 * - rAF loop 1 本: hidden tab / paused では draw を skip、t += min(dt, 0.1) * speed
 * - DPR cap (maxDpr、既定 1.25)
 * - prefers-reduced-motion: uTime = 12 の静止画。resize / quiet zone / preset 変化時だけ再描画
 * - webglcontextlost / restored 対応、WebGL 不可 / compile 失敗は何も描かず
 *   body の fallback 背景 (SURFACE_WEB.waterFallback) を見せる
 * - params 変更 (Home ↔ work screen の calm preset) は ~0.5s で補間 (reduced motion では即時)
 * - `data-water-glass` の面 (global nav / Home portal card) の下は liquid glass lens として
 *   屈折 + すりガラス + リムを GPU で描く (CSS は tint / 光沢縁だけ、backdrop-filter 不使用)
 * - glass の specular rim の光源 (uLight) は pointer の方向へ減衰付きで追従する
 *   (iPhone のジャイロの代わり)。reduced motion / touch 端末では左上固定
 * - canvas は 2 枚。水面 layer は position: fixed (rubber band 中も画面を覆い続け、端に帯が出ない)、
 *   glass layer は透明な canvas をスクロール内容の中に sticky で置き、glass の中だけを描く
 *   (uGlassOnly)。macOS の rubber band はスクロール内容だけを動かして fixed を動かさないので、
 *   glass を水面と同じ fixed canvas に描くと光・縁が DOM の枠から置いていかれる。glass layer を
 *   作れない環境では、従来どおり水面 layer に glass も描く
 * - <html data-water="webgl | fallback"> を立て、WebGL 不可時だけ CSS 側が backdrop-filter で
 *   glass を代替する (背景が静止しているので再合成コストが無い)
 *
 * canvas の `data-water-state` (animating | still | paused | hidden | fallback) は
 * e2e 検証用。
 */
import { useCallback, useEffect, useRef } from "react";
import fragSrc from "./water.frag.glsl?raw";
import { resolveWaterParams, type WaterParams } from "./waterDefaults";
import { useQuietZones, type ZoneLayer } from "./useQuietZones";

const VERT_SRC = "attribute vec2 a;\nvoid main() { gl_Position = vec4(a, 0.0, 1.0); }";
const STILL_TIME = 12.0;
/** 既定の光源 (左上から)。shader の uLight と CSS の --glass-light-angle の基準 */
const DEFAULT_LIGHT = { x: -0.6, y: 0.8 };
const UNIFORMS = [
  "uRes",
  "uTime",
  "uQuietRects[0]",
  "uQuietCount",
  "uScale",
  "uCaustic",
  "uRefr",
  "uTint",
  "uQuiet",
  "uGlassRects[0]",
  "uGlassMeta[0]",
  "uGlassCount",
  "uGlass",
  "uLight",
  "uGlassOnly",
] as const;
type UniformName = (typeof UNIFORMS)[number];

type Props = { params?: Partial<WaterParams>; paused?: boolean; className?: string; glassClassName?: string };

interface GlBundle {
  gl: WebGLRenderingContext;
  loc: Record<UniformName, WebGLUniformLocation | null>;
}

function buildProgram(gl: WebGLRenderingContext): GlBundle | null {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      if (import.meta.env.DEV) console.error("[WaterBackground] shader compile failed:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    if (import.meta.env.DEV) console.error("[WaterBackground] program link failed:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  const loc = {} as Record<UniformName, WebGLUniformLocation | null>;
  // 配列 uniform は bare name では null になる実装があるため "uQuietRects[0]" で取る (spec)
  for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(prog, n);
  return { gl, loc };
}

/** 1 枚の canvas + GL program。水面 layer (glassOnly = false) と glass layer (true) */
interface Layer {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  gl: WebGLRenderingContext;
  bundle: GlBundle | null;
  glassOnly: boolean;
  sizeKey: string;
  uploadedVersion: number;
}

function createLayer(host: HTMLElement, glassOnly: boolean): Layer | null {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);
  const gl = canvas.getContext("webgl", {
    antialias: false,
    // glass layer は glass の外を透明にして下の水面 layer を見せる (premultiplied で出力)
    alpha: glassOnly,
    premultipliedAlpha: true,
    powerPreference: "low-power",
  });
  const bundle = gl ? buildProgram(gl) : null;
  if (!gl || !bundle) {
    canvas.remove();
    return null;
  }
  return { canvas, host, gl, bundle, glassOnly, sizeKey: "", uploadedVersion: -1 };
}

export function WaterBackground({ params, paused = false, className, glassClassName }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const glassHostRef = useRef<HTMLDivElement>(null);
  const target = useRef<WaterParams>(resolveWaterParams(params));
  const pausedRef = useRef(paused);
  const dprRef = useRef(1);
  const layersRef = useRef<ZoneLayer[]>([]);
  const kick = useRef<() => void>(() => {});

  const getLayers = useCallback(() => layersRef.current, []);
  const onQuietChange = useCallback(() => kick.current(), []);
  const quiet = useQuietZones(getLayers, onQuietChange, glassHostRef);

  useEffect(() => {
    target.current = resolveWaterParams(params);
    kick.current();
  }, [params]);
  useEffect(() => {
    pausedRef.current = paused;
    kick.current();
  }, [paused]);

  useEffect(() => {
    // canvas は mount ごとに新規作成する (StrictMode の二重 mount で、cleanup の
    // loseContext() 済み context を再利用して compile に失敗するのを避ける)
    const host = hostRef.current;
    const glassHost = glassHostRef.current;
    if (!host) return;
    const setMode = (mode: "webgl" | "fallback") => {
      if (document.documentElement.dataset.water !== mode) document.documentElement.dataset.water = mode;
    };

    const water = createLayer(host, false);
    if (!water) {
      // WebGL 不可 / compile 失敗: 何も描かず body の fallback 背景を見せる (e2e 用に状態だけ残す)
      const marker = document.createElement("canvas");
      marker.setAttribute("aria-hidden", "true");
      marker.style.display = "none";
      marker.dataset.waterState = "fallback";
      host.appendChild(marker);
      setMode("fallback");
      return () => {
        marker.remove();
        layersRef.current = [];
        delete document.documentElement.dataset.water;
      };
    }
    const canvas = water.canvas;
    canvas.dataset.waterState = "init";
    const setState = (s: string) => {
      if (canvas.dataset.waterState !== s) canvas.dataset.waterState = s;
      setMode("webgl");
    };
    const glassLayer = glassHost ? createLayer(glassHost, true) : null;
    const layers: Layer[] = glassLayer ? [water, glassLayer] : [water];
    // glass layer が無ければ水面 layer に glass も描く (従来の 1 枚構成)
    layersRef.current = layers.map((l) => ({ canvas: l.canvas, glass: l.glassOnly || !glassLayer }));

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let still = reduce.matches;
    let raf = 0;
    let last = performance.now();
    let t = 0;
    let lost = false;
    let dirty = true;
    const cur: WaterParams = { ...target.current };
    // specular の光源: pointer の方向 (画面中心 → pointer、y up) へ減衰付きで寄せる
    const light = { ...DEFAULT_LIGHT };
    const lightTarget = { ...DEFAULT_LIGHT };
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const onPointer = (e: PointerEvent) => {
      if (still || !finePointer.matches) return;
      const dx = e.clientX - window.innerWidth / 2;
      const dy = window.innerHeight / 2 - e.clientY;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      lightTarget.x = dx / len;
      lightTarget.y = dy / len;
    };

    const resize = () => {
      dprRef.current = Math.min(window.devicePixelRatio || 1, target.current.maxDpr);
      for (const l of layers) {
        // host の実寸で解像度を決める (innerWidth / innerHeight は scrollbar を反映しない)
        const hb = l.host.getBoundingClientRect();
        const w = Math.round((hb.width || window.innerWidth) * dprRef.current);
        const h = Math.round((hb.height || window.innerHeight) * dprRef.current);
        const key = `${w}x${h}`;
        if (key === l.sizeKey) continue;
        l.sizeKey = key;
        l.canvas.width = w;
        l.canvas.height = h;
        l.gl.viewport(0, 0, w, h);
        dirty = true;
      }
    };

    const drawLayer = (l: Layer) => {
      if (!l.bundle) return;
      const { gl: g, loc } = l.bundle;
      g.uniform2f(loc.uRes, l.canvas.width, l.canvas.height);
      g.uniform1f(loc.uTime, still ? STILL_TIME : t);
      const q = quiet.current.stateFor(l.canvas);
      if (q.version !== l.uploadedVersion) {
        g.uniform4fv(loc["uQuietRects[0]"], q.rects);
        g.uniform1i(loc.uQuietCount, q.count);
        g.uniform4fv(loc["uGlassRects[0]"], q.glassRects);
        g.uniform4fv(loc["uGlassMeta[0]"], q.glassMeta);
        g.uniform1i(loc.uGlassCount, q.glassCount);
        l.uploadedVersion = q.version;
      }
      g.uniform1f(loc.uScale, cur.scale);
      g.uniform1f(loc.uCaustic, cur.caustic);
      g.uniform1f(loc.uRefr, cur.refraction);
      g.uniform1f(loc.uTint, cur.tint);
      g.uniform1f(loc.uQuiet, cur.quiet);
      g.uniform1f(loc.uGlass, cur.glass);
      g.uniform2f(loc.uLight, light.x, light.y);
      g.uniform1f(loc.uGlassOnly, l.glassOnly ? 1 : 0);
      g.drawArrays(g.TRIANGLES, 0, 3);
    };
    const draw = () => {
      for (const l of layers) drawLayer(l);
      dirty = false;
    };
    const stale = () => layers.some((l) => quiet.current.stateFor(l.canvas).version !== l.uploadedVersion);
    const approach = (dt: number): boolean => {
      const p = target.current;
      const k = still ? 1 : 1 - Math.exp(-dt / 0.18);
      let moving = false;
      for (const key of ["scale", "caustic", "refraction", "tint", "quiet", "glass"] as const) {
        const d = p[key] - cur[key];
        if (Math.abs(d) > 1e-4) {
          cur[key] += d * k;
          moving = true;
        } else cur[key] = p[key];
      }
      cur.speed = p.speed;
      cur.maxDpr = p.maxDpr;
      if (still) {
        light.x = DEFAULT_LIGHT.x;
        light.y = DEFAULT_LIGHT.y;
      } else {
        const kl = 1 - Math.exp(-dt / 0.25);
        light.x += (lightTarget.x - light.x) * kl;
        light.y += (lightTarget.y - light.y) * kl;
      }
      return moving;
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (lost) return;
      const hidden = document.visibilityState === "hidden";
      if (hidden || pausedRef.current) {
        setState(hidden ? "hidden" : "paused");
        return; // idle: visibilitychange / kick で再開
      }
      resize();
      // quiet / glass rect は描く直前に毎回取り直す (イベントで拾えない DOM の動きでも古い rect を残さない)
      quiet.current.measure();
      const moving = approach(dt);
      if (still) {
        // 静止画 1 枚を描いて loop を止める。resize / quiet zone / preset / motion 設定の
        // 変化は kick() で 1 frame だけ再描画する
        setState("still");
        if (dirty || moving || stale()) draw();
        return;
      }
      setState("animating");
      t += dt * cur.speed;
      draw();
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || lost) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    // 次の frame を 1 回だけ予約する (予約済みなら何もしない)。ここで予約済みの frame を
    // cancel してはいけない: glass の移動中や hover 中は quiet zone の再計算が毎 frame kick するので、
    // cancel → 予約し直しを繰り返すと描画 frame が永遠に後回しになり、canvas が古い glass 位置の
    // まま止まって DOM の枠と光・縁がずれる
    kick.current = () => {
      dirty = true;
      start();
    };

    const onVisibility = () => kick.current();
    const onMotion = () => {
      still = reduce.matches;
      kick.current();
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      stop();
    };
    const onRestored = () => {
      for (const l of layers) {
        if (l.gl.isContextLost()) continue;
        l.bundle = buildProgram(l.gl);
        l.sizeKey = "";
        l.uploadedVersion = -1;
      }
      if (layers.some((l) => l.gl.isContextLost())) return;
      lost = false;
      if (!water.bundle) {
        canvas.style.display = "none";
        setState("fallback");
        return;
      }
      kick.current();
    };
    const onResize = () => kick.current();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointermove", onPointer, { passive: true });
    reduce.addEventListener("change", onMotion);
    for (const l of layers) {
      l.canvas.addEventListener("webglcontextlost", onLost);
      l.canvas.addEventListener("webglcontextrestored", onRestored);
    }
    window.addEventListener("resize", onResize, { passive: true });
    // scrollbar の出入り (window resize が来ない) でも canvas を合わせ直す
    const hostRo = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    hostRo?.observe(host);
    if (glassHost) hostRo?.observe(glassHost);
    start();

    return () => {
      stop();
      kick.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      reduce.removeEventListener("change", onMotion);
      for (const l of layers) {
        l.canvas.removeEventListener("webglcontextlost", onLost);
        l.canvas.removeEventListener("webglcontextrestored", onRestored);
      }
      window.removeEventListener("resize", onResize);
      hostRo?.disconnect();
      for (const l of layers) {
        l.gl.getExtension("WEBGL_lose_context")?.loseContext();
        l.canvas.remove();
      }
      layersRef.current = [];
      delete document.documentElement.dataset.water;
    };
  }, [quiet]);

  return (
    <>
      <div ref={hostRef} className={className} aria-hidden="true" />
      {/* glass layer: スクロール内容の中の sticky (rubber band でも glass の DOM 枠と一緒に動く) */}
      <div className="water-track" aria-hidden="true">
        <div ref={glassHostRef} className={glassClassName} />
      </div>
    </>
  );
}
