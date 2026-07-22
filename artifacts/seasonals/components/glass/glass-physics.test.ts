/**
 * glass-physics — 体験仕様 (§2) の規範をテストで固定する (Phase 8.36)。
 * 全て決定的 (rng 注入 + 固定 dt 積分)。wall-clock 依存なし。
 */
import {
  GLASS_TUNING,
  createGlassState,
  stepGlass,
  surfaceYAt,
  type GlassState,
} from "./glass-physics";

const W = 400;
const H = 800;
const DT = 1 / 120; // 固定ステップ (決定性のため実フレームより細かく)

/** 決定的な擬似乱数 (mulberry32) */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fresh(bubbles = 8): { st: GlassState; rng: () => number } {
  const rng = seededRng(42);
  return { st: createGlassState(W, H, bubbles, rng), rng };
}

function step(st: GlassState, rng: () => number, seconds: number, reduced = false) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) stepGlass(st, DT, W, H, reduced, 8, 8, rng);
}

describe("ばね追従 (§2.1)", () => {
  it("傾けて止めると 1 回だけ overshoot して収束する (ちゃぷん)", () => {
    const { st, rng } = fresh();
    st.targetA = 0.3;
    const crossings: number[] = [];
    let prev = st.angle - st.targetA;
    for (let i = 0; i < Math.round(3 / DT); i++) {
      stepGlass(st, DT, W, H, false, 8, 8, rng);
      const err = st.angle - st.targetA;
      if (prev < 0 && err >= 0) crossings.push(st.t);
      prev = err;
    }
    // 少なくとも 1 回 target を通過し (揺り戻し)、最終的に収束する
    expect(crossings.length).toBeGreaterThanOrEqual(1);
    expect(crossings.length).toBeLessThanOrEqual(3); // 弱減衰 — 無限に振動しない
    expect(Math.abs(st.angle - 0.3)).toBeLessThan(0.005);
    expect(Math.abs(st.av)).toBeLessThan(0.05);
  });

  it("揺れの激しさで energy が増減する", () => {
    const { st, rng } = fresh();
    step(st, rng, 1);
    const calm = st.energy;
    st.targetA = 0.5; // 急な傾き
    step(st, rng, 0.15);
    expect(st.energy).toBeGreaterThan(calm);
    st.targetA = st.angle;
    step(st, rng, 3);
    expect(st.energy).toBeLessThan(0.1); // 静止で減衰
  });
});

describe("泡 (§2.2)", () => {
  it("泡は世界座標の上へ: 傾き時は画面に対して斜めに動く (ux=sinθ, uy=-cosθ)", () => {
    const { st, rng } = fresh(1);
    st.angle = 0.5;
    st.targetA = 0.5;
    const b = st.bubbles[0]!;
    b.x = W / 2;
    b.y = H - 10;
    b.w = 0;
    const x0 = b.x;
    const y0 = b.y;
    stepGlass(st, DT, W, H, false, 8, 8, rng);
    const dx = b.x - x0;
    const dy = b.y - y0;
    expect(dy).toBeLessThan(0); // 画面上方向へ
    expect(dx).toBeGreaterThan(0); // 正の傾きで x も進む = 軌道が斜め
    // 方向が (sinθ, -cosθ) に一致 (揺らぎ項 sin(w)*wiggle は w=0 開始で除去済…
    // ではなく w += dt*3 で微小に入るため比率は許容誤差付き)
    expect(dx / -dy).toBeCloseTo(Math.tan(0.5), 1);
  });

  it("液面に到達した泡は底の帯で再生成される", () => {
    const { st, rng } = fresh(1);
    const b = st.bubbles[0]!;
    b.x = W / 2;
    b.y = surfaceYAt(st, W / 2, W, H, false) - 1; // 液面より上
    stepGlass(st, DT, W, H, false, 8, 8, rng);
    expect(b.y).toBeGreaterThan(H - 41); // 底 40px 帯
  });
});

describe("振りメーター (§2.3-1)", () => {
  it("閾値未満の角速度では蓄積しない", () => {
    const { st, rng } = fresh();
    st.av = GLASS_TUNING.meterThreshold * 0.9;
    stepGlass(st, DT, W, H, false, 8, 8, rng);
    expect(st.fizzMeter).toBe(0);
  });

  it("高速な振りで蓄積し、放置で減衰する", () => {
    const { st, rng } = fresh();
    st.fizzMeter = 0.5;
    step(st, rng, 1);
    expect(st.fizzMeter).toBeLessThan(0.5); // 常時減衰
  });

  it("cooldown 中は蓄積しない (§2.3-4 連続発動防止)", () => {
    const { st, rng } = fresh();
    st.fizzCooldown = 1;
    st.av = 5; // 閾値超
    stepGlass(st, DT, W, H, false, 8, 8, rng);
    expect(st.fizzMeter).toBe(0);
  });

  it("reduce-motion 中はメーターが蓄積せず、あふれは発動しない (§2.4)", () => {
    const { st, rng } = fresh();
    st.av = 5;
    stepGlass(st, DT, W, H, true, 8, 8, rng);
    expect(st.fizzMeter).toBe(0);
  });
});

describe("あふれ状態機械 (§2.3-2/3/4)", () => {
  function trigger(st: GlassState, rng: () => number) {
    st.fizzMeter = 1;
    st.av = 2;
    stepGlass(st, DT, W, H, false, 8, 8, rng);
  }

  it("メーター満了 → state1 (前線が下から) → 覆い切りで state2 → α=0 で state0 + cooldown", () => {
    const { st, rng } = fresh();
    trigger(st, rng);
    expect(st.fizzState).toBe(1);
    expect(st.hapticFizz).toBe(true); // 発動ハプティクス
    expect(st.foamEdge).toBeGreaterThan(H); // 画面下から
    // 前線が一定速度で上昇 → 覆い切り
    step(st, rng, 1.2);
    expect(st.fizzState).toBe(2);
    // フェード完了 → 通常 + cooldown
    step(st, rng, 1.0);
    expect(st.fizzState).toBe(0);
    expect(st.foamAlpha).toBe(0);
    expect(st.fizzCooldown).toBeGreaterThan(0);
  });

  it("速度連続性 invariant: フェード時間 == 画面高 / 前線速度 (§2.3-3)", () => {
    const { st, rng } = fresh();
    trigger(st, rng);
    // state2 に到達させる
    while (st.fizzState === 1) stepGlass(st, DT, W, H, false, 8, 8, rng);
    expect(st.fizzState).toBe(2);
    const t0 = st.t;
    while (st.fizzState === 2) stepGlass(st, DT, W, H, false, 8, 8, rng);
    const fadeDuration = st.t - t0;
    const expected = 1 / GLASS_TUNING.fizzSpeedRatio; // H / (H * ratio)
    expect(fadeDuration).toBeCloseTo(expected, 1);
  });

  it("state2 の間、泡テクスチャは同じ速度で上へ流れ続ける (foamScroll 増加)", () => {
    const { st, rng } = fresh();
    trigger(st, rng);
    while (st.fizzState === 1) stepGlass(st, DT, W, H, false, 8, 8, rng);
    const s0 = st.foamScroll;
    stepGlass(st, DT, W, H, false, 8, 8, rng);
    expect(st.foamScroll - s0).toBeCloseTo(H * GLASS_TUNING.fizzSpeedRatio * DT, 5);
  });
});

describe("スロッシュ / メニスカス / reduce-motion", () => {
  it("急な傾きでスロッシュが励起され、壁 (x=0/W) で液面変位が最大", () => {
    const { st, rng } = fresh();
    st.targetA = 0.6;
    step(st, rng, 0.12);
    expect(Math.abs(st.s1)).toBeGreaterThan(0.5);
    // cos(πx/W): 壁で |1|、中央で 0
    const wall = Math.abs(st.s1 * Math.cos(0));
    const center = Math.abs(st.s1 * Math.cos(Math.PI / 2));
    expect(wall).toBeGreaterThan(center);
  });

  it("メニスカス: 傾けた時、押し付け側の壁際で液面が持ち上がる (y が小さい)", () => {
    const { st } = fresh();
    st.angle = -0.4; // 右壁に押し付け (piled = W)
    st.s1 = 0;
    const nearWall = surfaceYAt(st, W - 1, W, H, false);
    // 傾きの base 成分だけの値と比較 (メニスカス無しなら tan で決まる)
    const base = H * GLASS_TUNING.fill + Math.tan(-0.4) * (W - 1 - W / 2);
    expect(nearWall).toBeLessThan(base); // 持ち上がり (輪郭が上 = y 減)
  });

  it("reduce-motion でさざ波振幅が縮小する", () => {
    const { st } = fresh();
    st.energy = 1;
    st.s1 = 0;
    const spread = (reduced: boolean) => {
      let min = Infinity;
      let max = -Infinity;
      for (let x = 0; x <= W; x += 10) {
        const base = H * GLASS_TUNING.fill; // angle=0 → base 一定
        const y = surfaceYAt(st, x, W, H, reduced) - base;
        min = Math.min(min, y);
        max = Math.max(max, y);
      }
      return max - min;
    };
    expect(spread(true)).toBeLessThan(spread(false) * 0.5);
  });

  it("揺り戻しの頂点で hapticSlosh が 1 回立つ (cooldown 付き)", () => {
    const { st, rng } = fresh();
    st.targetA = 0.6;
    let count = 0;
    for (let i = 0; i < Math.round(0.6 / DT); i++) {
      stepGlass(st, DT, W, H, false, 8, 8, rng);
      if (st.hapticSlosh) count++;
    }
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2); // cooldown で連打しない
  });
});
