/**
 * GlassDebugOverlay — `?glass-debug` で開いた時だけ出す診断表示。
 * GPU に実際に upload されている glass / quiet rect を `gl.getUniform` で読み戻し
 * (= shader が本当に使っている値)、canvas の box 基準で CSS px に戻して シアン の枠で描く。
 * DOM 要素の実際の枠は 赤 で描く。2 つが重ならなければ WebGL の光・縁が DOM からずれている。
 * 左下に viewport / canvas / scroll の数値と、glass ごとの中心のずれ (px) を出す。
 */
import { useEffect, useState } from "react";
import { canvasFrame } from "./quietZones";

interface Shape {
  cx: number;
  cy: number;
  w: number;
  h: number;
  r: number;
  deg: number;
}
interface Snapshot {
  shader: Shape[];
  quiet: Shape[];
  dom: (Shape & { name: string })[];
  info: string[];
}

function read(): Snapshot | null {
  const canvas = document.querySelector<HTMLCanvasElement>(".water-canvas canvas");
  const gl = canvas?.getContext("webgl");
  const prog = gl?.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null | undefined;
  if (!canvas || !gl || !prog) return null;
  const f = canvasFrame(canvas);
  const u = (name: string) => gl.getUniform(prog, gl.getUniformLocation(prog, name)!) as number[] | number;
  const toCss = (x: number, y: number) => ({ cx: f.left + x / f.scale, cy: f.bottom - y / f.scale });
  const shader: Shape[] = [];
  for (let i = 0; i < Number(u("uGlassCount")); i++) {
    const g = u(`uGlassRects[${i}]`) as number[];
    const m = u(`uGlassMeta[${i}]`) as number[];
    shader.push({ ...toCss(g[0]!, g[1]!), w: g[2]! / f.scale, h: g[3]! / f.scale, r: m[0]! / f.scale, deg: (m[1]! * 180) / Math.PI });
  }
  const quiet: Shape[] = [];
  for (let i = 0; i < Number(u("uQuietCount")); i++) {
    const q = u(`uQuietRects[${i}]`) as number[];
    const c = toCss(q[0]! + q[2]! / 2, q[1]! + q[3]! / 2);
    quiet.push({ ...c, w: q[2]! / f.scale, h: q[3]! / f.scale, r: 0, deg: 0 });
  }
  const dom = [...document.querySelectorAll<HTMLElement>("[data-water-glass]")].map((el) => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const m = /^matrix(3d)?\(([^)]+)\)$/.exec(cs.transform);
    const v = m ? m[2]!.split(",").map(Number) : [1, 0];
    return {
      name: el.className.split(" ")[0] ?? "",
      cx: b.left + b.width / 2,
      cy: b.top + b.height / 2,
      w: el.offsetWidth,
      h: el.offsetHeight,
      r: Math.min(Number.parseFloat(cs.borderTopLeftRadius) || 0, el.offsetWidth / 2, el.offsetHeight / 2),
      deg: (Math.atan2(v[1] ?? 0, v[0] ?? 1) * 180) / Math.PI,
    };
  });
  const cb = canvas.getBoundingClientRect();
  const vv = window.visualViewport;
  const info = [
    `dpr ${devicePixelRatio}  inner ${innerWidth}×${innerHeight}  client ${document.documentElement.clientWidth}×${document.documentElement.clientHeight}`,
    `canvas box ${cb.left.toFixed(1)},${cb.top.toFixed(1)} ${cb.width.toFixed(1)}×${cb.height.toFixed(1)}  buffer ${canvas.width}×${canvas.height}  scale ${f.scale.toFixed(3)}`,
    `scrollY ${scrollY.toFixed(1)}  vv ${vv ? `${vv.width.toFixed(0)}×${vv.height.toFixed(0)} scale ${vv.scale.toFixed(2)} top ${vv.offsetTop.toFixed(1)}` : "n/a"}  state ${canvas.dataset.waterState}`,
    ...dom.map((d) => {
      const s = shader.reduce<Shape | null>((best, x) => (!best || Math.hypot(x.cx - d.cx, x.cy - d.cy) < Math.hypot(best.cx - d.cx, best.cy - d.cy) ? x : best), null);
      return s ? `${d.name}: shader − DOM = (${(s.cx - d.cx).toFixed(1)}, ${(s.cy - d.cy).toFixed(1)}) px` : `${d.name}: not in shader`;
    }),
  ];
  return { shader, quiet, dom, info };
}

function Rect({ s, stroke, dash }: { s: Shape; stroke: string; dash?: string }) {
  return (
    <rect
      x={s.cx - s.w / 2}
      y={s.cy - s.h / 2}
      width={s.w}
      height={s.h}
      rx={s.r}
      fill="none"
      stroke={stroke}
      strokeWidth={1.5}
      strokeDasharray={dash}
      transform={`rotate(${s.deg} ${s.cx} ${s.cy})`}
    />
  );
}

export function GlassDebugOverlay() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useEffect(() => {
    let id = 0;
    const tick = () => {
      setSnap(read());
      id = window.setTimeout(tick, 120);
    };
    tick();
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className="glass-debug" aria-hidden="true">
      <svg width="100%" height="100%">
        {snap?.quiet.map((s, i) => <Rect key={`q${i}`} s={s} stroke="orange" dash="4 4" />)}
        {snap?.dom.map((s, i) => <Rect key={`d${i}`} s={s} stroke="red" />)}
        {snap?.shader.map((s, i) => <Rect key={`s${i}`} s={s} stroke="cyan" dash="6 3" />)}
      </svg>
      <pre className="glass-debug-info">
        {snap ? ["glass-debug: cyan = shader (GPU), red = DOM, orange = quiet", ...snap.info].join("\n") : "glass-debug: WebGL not running"}
      </pre>
    </div>
  );
}
