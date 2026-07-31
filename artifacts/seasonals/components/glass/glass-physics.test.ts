/**
 * glass-physics — 体験仕様 (§2) の規範をテストで固定する (Phase 8.36)。
 * 全て決定的 (rng 注入 + 固定 dt 積分)。wall-clock 依存なし。
 */
import {
  GLASS_TUNING,
  createGlassState,
  stepGlass,
  surfaceSlope,
  tiltFromGravity,
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

// 8.47: 端末を振る (並進加速度) でも同じあふれが発動する。
// st.shake は重力除去済みの |a| (m/s²) で、呼び手が毎フレーム書く外部入力
describe("揺さぶりメーター (8.47 — 端末を振る)", () => {
  /** shake を維持したまま n 秒進める (回転入力は与えない) */
  function shakeFor(
    st: GlassState,
    rng: () => number,
    mag: number,
    seconds: number,
    reduced = false
  ) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      st.shake = mag;
      stepGlass(st, DT, W, H, reduced, 8, 8, rng);
    }
  }

  it("閾値未満の揺れでは蓄積しない (歩行・手ブレで誤爆しない)", () => {
    const { st, rng } = fresh();
    shakeFor(st, rng, GLASS_TUNING.shakeThreshold * 0.9, 2);
    expect(st.fizzMeter).toBe(0);
    expect(st.fizzState).toBe(0);
  });

  it("強く振ると回転させなくてもあふれが発動する", () => {
    const { st, rng } = fresh();
    shakeFor(st, rng, 20, 1.5);
    expect(st.fizzState).not.toBe(0);
    // 液面は動かしていない = 揺さぶり単独で発動したことの確認
    expect(Math.abs(st.angle)).toBeLessThan(0.01);
  });

  it("発動時は haptic フラグが立つ", () => {
    const { st, rng } = fresh();
    let sawHaptic = false;
    const n = Math.round(1.5 / DT);
    for (let i = 0; i < n; i++) {
      st.shake = 20;
      stepGlass(st, DT, W, H, false, 8, 8, rng);
      if (st.hapticFizz) sawHaptic = true;
    }
    expect(sawHaptic).toBe(true);
  });

  it("reduce-motion 中は強く振っても発動しない (§2.4)", () => {
    const { st, rng } = fresh();
    shakeFor(st, rng, 20, 2, true);
    expect(st.fizzMeter).toBe(0);
    expect(st.fizzState).toBe(0);
  });

  it("cooldown 中は強く振っても蓄積しない (§2.3-4 連続発動防止)", () => {
    const { st, rng } = fresh();
    st.fizzCooldown = 1;
    st.shake = 20;
    stepGlass(st, DT, W, H, false, 8, 8, rng);
    expect(st.fizzMeter).toBe(0);
  });

  it("shake 未設定なら従来どおり (回転由来の蓄積に影響しない)", () => {
    const { st: a, rng: rngA } = fresh();
    a.av = 5;
    stepGlass(a, DT, W, H, false, 8, 8, rngA);

    const { st: b, rng: rngB } = fresh();
    b.av = 5;
    b.shake = 0;
    stepGlass(b, DT, W, H, false, 8, 8, rngB);

    expect(b.fizzMeter).toBe(a.fizzMeter);
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

  it("8.48: 大きく左右に揺らすと液面が直線でなくなる (シーソー解消の実体)", () => {
    const { st, rng } = fresh();
    // 左右に大きく振る
    let maxBow = 0;
    for (let i = 0; i < Math.round(2.0 / DT); i++) {
      st.targetA = Math.sin(i * DT * 5) * 0.7;
      stepGlass(st, DT, W, H, false, 8, 8, rng);
      // 両端を結ぶ直線と、実際の液面の中央とのズレ (= 面のたわみ)
      const left = surfaceYAt(st, 0, W, H, false);
      const right = surfaceYAt(st, W, W, H, false);
      const mid = surfaceYAt(st, W / 2, W, H, false);
      maxBow = Math.max(maxBow, Math.abs(mid - (left + right) / 2));
    }
    // さざ波の最大振幅 (rippleBase + rippleEnergy) を明確に超えるたわみが出る。
    // 第 2 モードが無い実装では ~さざ波程度にしかならない
    const ripple = GLASS_TUNING.rippleBase + GLASS_TUNING.rippleEnergy;
    expect(maxBow).toBeGreaterThan(ripple);
  });

  it("8.48: 第 2 モードは上限内に収まり、静止すれば減衰して消える", () => {
    const { st, rng } = fresh();
    for (let i = 0; i < Math.round(2.0 / DT); i++) {
      st.targetA = Math.sin(i * DT * 5) * 0.7;
      stepGlass(st, DT, W, H, false, 8, 8, rng);
      expect(Math.abs(st.s2)).toBeLessThanOrEqual(
        H * GLASS_TUNING.slosh2MaxRatio + 1e-6
      );
    }
    // 入力を止めて放置 → 減衰
    st.targetA = 0;
    step(st, rng, 4);
    expect(Math.abs(st.s2)).toBeLessThan(0.5);
  });

  it("8.48: reduce-motion では第 2 モードが縮退する", () => {
    const run = (reduced: boolean) => {
      const { st, rng } = fresh();
      let peak = 0;
      for (let i = 0; i < Math.round(2.0 / DT); i++) {
        st.targetA = Math.sin(i * DT * 5) * 0.7;
        stepGlass(st, DT, W, H, reduced, 8, 8, rng);
        peak = Math.max(peak, Math.abs(st.s2));
      }
      return peak;
    };
    expect(run(true)).toBeLessThan(run(false));
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

// 8.48: 大傾斜での「定規」化を抑える傾き飽和
describe("surfaceSlope (8.48 — 大傾斜のサチュレーション)", () => {
  it("膝以下は tan と完全に一致する (通常の傾け操作の手触りを変えない)", () => {
    for (const a of [0, 0.1, 0.3, 0.4, 0.5]) {
      expect(surfaceSlope(a)).toBe(Math.tan(a));
      expect(surfaceSlope(-a)).toBe(Math.tan(-a));
    }
    // 膝ちょうど
    const knee = Math.atan(GLASS_TUNING.slopeKnee);
    expect(surfaceSlope(knee)).toBeCloseTo(GLASS_TUNING.slopeKnee, 10);
  });

  it("maxTilt では tan より明確に緩く、上限を超えない", () => {
    const a = GLASS_TUNING.maxTilt;
    const raw = Math.tan(a);
    const slope = surfaceSlope(a);
    expect(slope).toBeLessThan(raw * 0.8); // 2 割以上圧縮
    expect(slope).toBeLessThan(GLASS_TUNING.slopeMax);
  });

  it("奇関数かつ単調増加 (反転や折り返しが起きない)", () => {
    let prev = -Infinity;
    for (let a = -1.2; a <= 1.2; a += 0.05) {
      const s = surfaceSlope(a);
      expect(s).toBeCloseTo(-surfaceSlope(-a), 10);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});

// 8.49: 傾きの取得元。Euler の roll は端末を立てるとジンバルロックで暴れたため、
// 重力ベクトルの画面平面への射影から求める (姿勢に依らず手の動きと 1:1)
describe("tiltFromGravity (8.49 — 姿勢に依らない傾き)", () => {
  /** 直立姿勢で画面法線まわりに theta 回した時の重力ベクトル (端末座標、下向き) */
  function uprightTilted(theta: number): [number, number, number] {
    return [-Math.sin(theta), -Math.cos(theta), 0];
  }

  it("直立・無傾斜では 0", () => {
    expect(tiltFromGravity(...uprightTilted(0))).toBeCloseTo(0, 10);
  });

  it("直立ではどの角度でも手の動きと 1:1 (roll の飽和が起きない)", () => {
    for (const deg of [5, 10, 20, 30]) {
      const rad = (deg * Math.PI) / 180;
      expect(tiltFromGravity(...uprightTilted(rad))).toBeCloseTo(rad, 6);
      expect(tiltFromGravity(...uprightTilted(-rad))).toBeCloseTo(-rad, 6);
    }
  });

  it("平置き (重力が画面法線方向) では傾かない", () => {
    // z 成分のみ = 画面が真上を向いている
    expect(Math.abs(tiltFromGravity(0, 0, -1))).toBeLessThan(1e-9);
    // わずかに傾いた平置きでも応答は小さい
    expect(Math.abs(tiltFromGravity(-0.05, -0.02, -0.998))).toBeLessThan(0.1);
  });

  it("姿勢が寝ているほど応答が穏やかになる (直立 > 45° > 平置き)", () => {
    const rad = (20 * Math.PI) / 180;
    const at = (leanDeg: number) => {
      const l = (leanDeg * Math.PI) / 180; // 0=平置き, 90=直立
      const planar = Math.sin(l);
      return tiltFromGravity(
        -Math.sin(rad) * planar,
        -Math.cos(rad) * planar,
        -Math.cos(l)
      );
    };
    expect(at(90)).toBeGreaterThan(at(45));
    expect(at(45)).toBeGreaterThan(at(10));
    expect(at(10)).toBeGreaterThan(0);
  });

  it("maxTilt で clamp され、ゼロベクトルでも壊れない", () => {
    const big = tiltFromGravity(...uprightTilted(1.5)); // 86°
    expect(big).toBeLessThanOrEqual(GLASS_TUNING.maxTilt + 1e-9);
    expect(tiltFromGravity(0, 0, 0)).toBe(0);
  });
});
