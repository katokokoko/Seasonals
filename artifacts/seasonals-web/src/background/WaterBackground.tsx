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
 * - <html data-water="webgl | fallback"> を立て、WebGL 不可時だけ CSS 側が backdrop-filter で
 *   glass を代替する (背景が静止しているので再合成コストが無い)
 *
 * canvas の `data-water-state` (animating | still | paused | hidden | fallback) は
 * e2e 検証用。
 */
import { useCallback, useEffect, useRef } from "react";
import fragSrc from "./water.frag.glsl?raw";
import { resolveWaterParams, type WaterParams } from "./waterDefaults";
import { useQuietZones } from "./useQuietZones";

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
] as const;
type UniformName = (typeof UNIFORMS)[number];

type Props = { params?: Partial<WaterParams>; paused?: boolean; className?: string };

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

export function WaterBackground({ params, paused = false, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const target = useRef<WaterParams>(resolveWaterParams(params));
  const pausedRef = useRef(paused);
  const dprRef = useRef(1);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const kick = useRef<() => void>(() => {});

  const getCanvas = useCallback(() => canvasRef.current, []);
  const onQuietChange = useCallback(() => kick.current(), []);
  const quiet = useQuietZones(getCanvas, onQuietChange, hostRef);

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
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.waterState = "init";
    host.appendChild(canvas);
    canvasRef.current = canvas;
    const setState = (s: string) => {
      if (canvas.dataset.waterState !== s) canvas.dataset.waterState = s;
      const mode = s === "fallback" ? "fallback" : "webgl";
      if (document.documentElement.dataset.water !== mode) document.documentElement.dataset.water = mode;
    };

    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    let bundle: GlBundle | null = gl ? buildProgram(gl) : null;
    if (!bundle) {
      canvas.style.display = "none";
      setState("fallback");
      return () => {
        canvas.remove();
        if (canvasRef.current === canvas) canvasRef.current = null;
        delete document.documentElement.dataset.water;
      };
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let still = reduce.matches;
    let raf = 0;
    let last = performance.now();
    let t = 0;
    let lost = false;
    let dirty = true;
    let uploadedVersion = -1;
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
    let sizeKey = "";

    const resize = () => {
      const p = target.current;
      dprRef.current = Math.min(window.devicePixelRatio || 1, p.maxDpr);
      // host (sticky + 上下 overscan) の実寸で解像度を決める (innerWidth / innerHeight は
      // scrollbar も overscan も反映しないので絵が伸びてずれる)
      const hb = host.getBoundingClientRect();
      const vp = { width: hb.width || window.innerWidth, height: hb.height || window.innerHeight };
      const w = Math.round(vp.width * dprRef.current);
      const h = Math.round(vp.height * dprRef.current);
      const key = `${w}x${h}`;
      if (key === sizeKey) return;
      sizeKey = key;
      canvas.width = w;
      canvas.height = h;
      bundle?.gl.viewport(0, 0, w, h);
      dirty = true;
    };

    const draw = () => {
      if (!bundle) return;
      const { gl: g, loc } = bundle;
      g.uniform2f(loc.uRes, canvas.width, canvas.height);
      g.uniform1f(loc.uTime, still ? STILL_TIME : t);
      const q = quiet.current.state;
      if (q.version !== uploadedVersion) {
        g.uniform4fv(loc["uQuietRects[0]"], q.rects);
        g.uniform1i(loc.uQuietCount, q.count);
        g.uniform4fv(loc["uGlassRects[0]"], q.glassRects);
        g.uniform4fv(loc["uGlassMeta[0]"], q.glassMeta);
        g.uniform1i(loc.uGlassCount, q.glassCount);
        uploadedVersion = q.version;
      }
      g.uniform1f(loc.uScale, cur.scale);
      g.uniform1f(loc.uCaustic, cur.caustic);
      g.uniform1f(loc.uRefr, cur.refraction);
      g.uniform1f(loc.uTint, cur.tint);
      g.uniform1f(loc.uQuiet, cur.quiet);
      g.uniform1f(loc.uGlass, cur.glass);
      g.uniform2f(loc.uLight, light.x, light.y);
      g.drawArrays(g.TRIANGLES, 0, 3);
      dirty = false;
    };

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
        if (dirty || moving || quiet.current.state.version !== uploadedVersion) draw();
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
      bundle = gl ? buildProgram(gl) : null;
      lost = false;
      sizeKey = "";
      uploadedVersion = -1;
      if (!bundle) {
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
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    window.addEventListener("resize", onResize, { passive: true });
    // scrollbar の出入り (window resize が来ない) でも canvas を合わせ直す
    const hostRo = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    hostRo?.observe(host);
    start();

    return () => {
      stop();
      kick.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      reduce.removeEventListener("change", onMotion);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      window.removeEventListener("resize", onResize);
      hostRo?.disconnect();
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
      if (canvasRef.current === canvas) canvasRef.current = null;
      delete document.documentElement.dataset.water;
    };
  }, [quiet]);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}
