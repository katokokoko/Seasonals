/**
 * glass-physics — 「グラスの中」液体演出の物理コア (Phase 8.36)
 *
 * ブラウザプロトタイプ (seasonals-soda-tilt.html) で検証済みのモデルの移植:
 *   - 液面角度: ばね追従 (弱減衰で 1 回だけ「ちゃぷん」と揺り戻す — 体験仕様 §2.1)
 *   - さざ波: 2 周波正弦波、振幅は揺れエネルギー連動
 *   - スロッシュ: 第 1 モード定在波 cos(πx/W)、容器の角加速度で励起される減衰振動子
 *   - メニスカス: 押し付けられた側の壁で液面を持ち上げる指数減衰項
 *   - 泡: 常に世界座標の上 (重力の逆) へ上昇 — 傾けると画面に対して斜めに (§2.2)
 *   - 振りメーター → 泡あふれ状態機械 (§2.3): 前線が一定速度で上昇して覆い、
 *     覆い切ったら同じ速度感のままフェード。**α減少率 = 前線速度 / 画面高** で
 *     「上昇がそのままフェードに連続して見える」速度連続性を定数レベルで保証する
 *
 * 全関数 worklet-safe (Reanimated UI thread から呼ぶ。jest では素の JS として動く)。
 * 係数は GLASS_TUNING に集約 — **プロトタイプ値は出発点であり、Seeker 実機の
 * 手触りで再調整する前提** (docs/confirm.md §A)。
 */

export const GLASS_TUNING = {
  /** 静止時の液面位置 (画面 top からの比率) */
  fill: 0.42,
  /** 追従する最大傾き (rad) */
  maxTilt: (55 * Math.PI) / 180,

  // ばね追従 (§2.1 — 弱減衰で 1 回の揺り戻し)
  springK: 34,
  springC: 4.2,

  // さざ波 (振幅は energy 連動)
  rippleBase: 3,
  rippleEnergy: 12,
  rippleBaseReduced: 1.5,
  rippleEnergyReduced: 2.5,

  // スロッシュ定在波 (第 1 モード)
  sloshOmega: 5.4,
  sloshZeta: 0.1,
  sloshDrive: 0.045,
  /** 定在波振幅の上限 (画面高比) */
  sloshMaxRatio: 0.055,

  // 8.48: 第 2 モード (対称、中央が腹)。第 1 モードと傾き項はどちらも中央が
  // 節なので、これが無いと液面は「中点を支点にした板」= シーソーにしか見えない
  /** ω₂/ω₁。2.0 に置くと非線形結合項 (2ω₁ で振動) と共鳴し、大きく振った時だけ立つ */
  slosh2Ratio: 2.0,
  /** 高次ほど早く収まる (第 1 モードの 0.1 より強い減衰) */
  slosh2Zeta: 0.16,
  /** 第 1 モードからの非線形結合の強さ (大きいほど、揺らすと面が曲がる) */
  slosh2Couple: 9,
  /** 振幅上限 (画面高比)。第 1 モードより控えめに */
  slosh2MaxRatio: 0.03,

  // 8.48: 大傾斜の傾き飽和。maxTilt 55° の tan=1.43 は幅 1200px で壁際 ±857px に
  // なり「画面を横切る定規」に見える。膝 (slopeKnee) 以下は tan のまま
  slopeKnee: 0.6, // ≈31° まで恒等
  slopeMax: 1.0, // これに向けて飽和

  // メニスカス (壁際の持ち上がり)
  meniscusLen: 24,
  meniscusBase: 14,
  meniscusEnergy: 26,

  // 泡
  bubbleCount: 60,
  bubbleCountLow: 28,
  bubbleSpeedMin: 26,
  bubbleSpeedRange: 55,
  bubbleWiggle: 9,

  // 飛沫 (壁際で液面が速く跳ねた時)
  dropletMax: 36,
  dropletMaxLow: 16,
  dropletSpawnVel: 70,
  dropletSpawnRate: 26,
  dropletLifeDecay: 1.1,
  dropletGravity: 900,

  // 振りメーター (§2.3-1 — 意図的に振らないと発動しない)
  meterThreshold: 1.1, // rad/s
  meterGain: 0.9,
  meterDecay: 0.45,
  // 8.47: 端末を振る (並進の揺さぶり) 由来の入力。単位 m/s²、重力除去済みの
  // linear acceleration なので静止時 ~0。意図的な振りは 15+ が出る一方、
  // 歩行や手ブレは 10 未満に収まるため、その間に閾値を置く
  shakeThreshold: 9,
  shakeGain: 0.45,
  /** 前兆泡が出始めるメーター値 */
  meterForeshadow: 0.35,

  // 泡あふれ (§2.3-2/3 — 速度連続性の核)
  /** 前線の上昇速度 (画面高比 / 秒)。フェード時間 = 1 / この値 に一致する */
  fizzSpeedRatio: 1.2,
  /** 発動後のクールダウン秒 (§2.3-4) */
  fizzCooldown: 2,
  /** 前線の開始 y (画面下端からのはみ出し) / 覆い切り判定 y (上端からのはみ出し) */
  fizzStartOvershoot: 60,
  fizzCoverOvershoot: 90,

  // ハプティクス (揺り戻し・発動に同期、fire-and-forget)
  hapticSloshMin: 0.006, // 画面高比 — これ以上の定在波振幅で「ちゃぷん」
  hapticCooldownS: 0.3,
} as const;

export type FizzState = 0 | 1 | 2; // 0: 通常 / 1: 前線上昇 / 2: 覆ったままフェード

export interface GlassBubble {
  x: number;
  y: number;
  r: number;
  s: number; // 上昇速度 px/s
  w: number; // 揺らぎ位相
}

export interface GlassDroplet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
}

export interface GlassState {
  angle: number; // 液面角度 (ばね追従)
  av: number; // 角速度
  targetA: number; // 目標角度 (センサー由来、呼び手が書く)
  /** 8.47: 端末の揺さぶりの強さ m/s² (重力除去済み。targetA と同じく呼び手が毎フレーム書く) */
  shake: number;
  energy: number; // 揺れエネルギー (0..1)
  s1: number; // スロッシュ定在波の振幅 (第 1 モード、反対称: 壁が腹・中央が節)
  s1v: number;
  s2: number; // 8.48: 第 2 モード (対称: 壁と中央が腹)。面を曲げてシーソー感を消す
  s2v: number;
  fizzMeter: number;
  fizzState: FizzState;
  foamEdge: number; // あふれ前線の y
  foamAlpha: number; // 覆いの不透明度
  foamScroll: number; // 泡テクスチャの上方向スクロール量
  fizzCooldown: number;
  t: number; // 経過秒 (波位相用)
  bubbles: GlassBubble[];
  droplets: GlassDroplet[];
  // 1 フレーム限りのイベントフラグ (消費側が読んでクリアする)
  hapticSlosh: boolean;
  hapticFizz: boolean;
  lastSloshHapticT: number;
  prevS1v: number;
}

function rand(rng: (() => number) | undefined): number {
  "worklet";
  return rng ? rng() : Math.random();
}

export function makeBubble(
  W: number,
  H: number,
  rng?: () => number,
  x?: number,
  y?: number
): GlassBubble {
  "worklet";
  return {
    x: x !== undefined ? x : rand(rng) * W,
    y: y !== undefined ? y : H - rand(rng) * H * 0.35,
    r: 1.2 + rand(rng) * 2.6,
    s: GLASS_TUNING.bubbleSpeedMin + rand(rng) * GLASS_TUNING.bubbleSpeedRange,
    w: rand(rng) * Math.PI * 2,
  };
}

export function createGlassState(
  W: number,
  H: number,
  bubbleCountIn?: number,
  rng?: () => number
): GlassState {
  "worklet";
  // stepGlass と同じ理由でデフォルト引数に GLASS_TUNING を使わない (worklet 制約)
  const bubbleCount = bubbleCountIn ?? GLASS_TUNING.bubbleCount;
  const bubbles: GlassBubble[] = [];
  for (let i = 0; i < bubbleCount; i++) {
    bubbles.push(
      makeBubble(W, H, rng, rand(rng) * W, H * 0.45 + rand(rng) * H * 0.55)
    );
  }
  return {
    angle: 0,
    av: 0,
    targetA: 0,
    shake: 0,
    energy: 0,
    s1: 0,
    s1v: 0,
    s2: 0,
    s2v: 0,
    fizzMeter: 0,
    fizzState: 0,
    foamEdge: 0,
    foamAlpha: 0,
    foamScroll: 0,
    fizzCooldown: 0,
    t: 0,
    bubbles,
    droplets: [],
    hapticSlosh: false,
    hapticFizz: false,
    lastSloshHapticT: -1,
    prevS1v: 0,
  };
}

/**
 * 8.49: 重力ベクトル (端末座標) → 液面の目標傾き (rad)。
 *
 * 8.48 まで使っていた Euler の roll (`SensorManager.getOrientation()[2]`) は、
 * **端末を立てて持つとジンバルロック近傍**に入り破綻する。数値実験の実測:
 *
 *   端末の姿勢   手を 5° 動かした時の roll
 *   平置き       0°     (全く反応しない)
 *   45°          5°     (ほぼ 1:1)
 *   85°         45°     (9 倍)
 *   直立        90°     (即飽和 → maxTilt に張り付く)
 *
 * カレンダーを見る姿勢 = ほぼ直立なので、「ちょっと傾けただけで液体が大きく揺れる」
 * のはこれが原因だった。重力を画面平面に射影して向きを取れば特異点が無く、
 * どの姿勢でも手の動きと 1:1 になる。
 *
 * 引数は reanimated の GRAVITY センサー値 (= Android TYPE_GRAVITY を符号反転した
 * もの = **実際の重力の向き**)。画面座標は x=右 / y=下 なので、画面平面での重力は
 * (x, -y)。液面はそれに直交するので傾き角は atan2(-x, -y)。
 *
 * `lean` は「端末がどれだけ立っているか」(平置き 0 / 直立 1)。平置きのグラスは
 * 傾かないのが物理的に正しく、射影が縮退する領域を同時に無害化できる。
 */
export function tiltFromGravity(x: number, y: number, z: number): number {
  "worklet";
  const T = GLASS_TUNING;
  const mag = Math.sqrt(x * x + y * y + z * z);
  if (mag < 1e-6) return 0;
  const planar = Math.sqrt(x * x + y * y);
  const angle = Math.atan2(-x, -y);
  const lean = planar / mag;
  const t = angle * lean;
  return Math.max(-T.maxTilt, Math.min(T.maxTilt, t));
}

/**
 * 8.48: 傾き角 → 液面の傾き (dy/dx)。膝 (slopeKnee) までは `tan` そのままで、
 * それ以上を `slopeMax` へ向けて滑らかに飽和させる。
 *
 * 素の `tan` だと maxTilt 55° で 1.43 になり、幅 1200px の画面では壁際が ±857px
 * ずれて「画面を横切る定規」に見える。膝以下を恒等にしてあるので、通常の傾け操作
 * (〜31°) の手触りは一切変わらない。
 */
export function surfaceSlope(angle: number): number {
  "worklet";
  const T = GLASS_TUNING;
  const t = Math.tan(Math.max(-1.2, Math.min(1.2, angle)));
  const a = Math.abs(t);
  if (a <= T.slopeKnee) return t;
  const span = T.slopeMax - T.slopeKnee;
  const sat = T.slopeKnee + span * Math.tanh((a - T.slopeKnee) / span);
  return t < 0 ? -sat : sat;
}

/**
 * 液面の y 座標 (画面座標)。base (傾き) + さざ波 + 定在波 (1 次/2 次) + メニスカス。
 */
export function surfaceYAt(
  st: GlassState,
  x: number,
  W: number,
  H: number,
  reduced: boolean
): number {
  "worklet";
  const T = GLASS_TUNING;
  let y = H * T.fill + surfaceSlope(st.angle) * (x - W / 2);
  const amp = reduced
    ? T.rippleBaseReduced + st.energy * T.rippleEnergyReduced
    : T.rippleBase + st.energy * T.rippleEnergy;
  y +=
    amp *
    (0.6 * Math.sin(x * 0.018 + st.t * 3.1) +
      0.4 * Math.sin(x * 0.031 - st.t * 4.3));
  // スロッシュ定在波 (1 次): cos(πx/W) — 両端の壁が腹、中央は節
  y += st.s1 * Math.cos((Math.PI * x) / W);
  // 8.48 (2 次): cos(2πx/W) — 壁で +1・中央で −1。**中央が動く唯一の項**で、
  // これが面を曲げてシーソー (中点を支点にした板) の見え方を壊す
  y += st.s2 * Math.cos((2 * Math.PI * x) / W);
  // メニスカス: 液が押し付けられている側の壁を這い上がる
  const piled = st.angle > 0 ? 0 : W;
  const d = Math.abs(x - piled);
  y -=
    Math.min(1, Math.abs(st.angle) / 0.6) *
    (T.meniscusBase + st.energy * T.meniscusEnergy) *
    Math.exp(-d / T.meniscusLen);
  return y;
}

/**
 * 1 フレームの物理積分 (in-place 変異)。dt は秒 (呼び手が ≤0.033 に clamp 推奨)。
 * reduced = reduce-motion: 波振幅・励起・飛沫・あふれ発動を縮退させる (§2.4)。
 */
export function stepGlass(
  st: GlassState,
  dt: number,
  W: number,
  H: number,
  reduced: boolean,
  bubbleCapIn?: number,
  dropletCapIn?: number,
  rng?: () => number
): void {
  "worklet";
  // NOTE: worklet ではデフォルト引数に closure 変数 (GLASS_TUNING) を使えない —
  // 生成コードの closure 展開 (this.__closure) は本体先頭で行われ、デフォルト
  // 引数の評価がそれより先のため UI runtime で
  // "Property 'GLASS_TUNING' doesn't exist" になる。本体で ?? 解決する
  const T = GLASS_TUNING;
  const bubbleCap = bubbleCapIn ?? T.bubbleCount;
  const dropletCap = dropletCapIn ?? T.dropletMax;
  st.t += dt;
  st.hapticSlosh = false;
  st.hapticFizz = false;

  // ── ばね追従 (§2.1) ──
  const acc = T.springK * (st.targetA - st.angle) - T.springC * st.av;
  st.av += acc * dt;
  st.angle += st.av * dt;

  const e = Math.min(
    1,
    Math.abs(st.av) * 2.0 + Math.abs(st.targetA - st.angle) * 1.2
  );
  st.energy += (e - st.energy) * Math.min(1, dt * 3);

  // ── 振りメーター → あふれ状態機械 (§2.3) ──
  const fizzV = H * T.fizzSpeedRatio; // 前線速度 px/s
  if (st.fizzState === 0) {
    st.fizzCooldown = Math.max(0, st.fizzCooldown - dt);
    st.fizzMeter = Math.max(0, st.fizzMeter - dt * T.meterDecay);
    if (st.fizzCooldown === 0 && !reduced) {
      // 8.47: 2 系統の入力を同じメーターに合流させる。
      //   swing = 液面を波打たせる (端末の回転由来の角速度 rad/s)
      //   shake = 端末を振る (重力除去済みの並進加速度 m/s²)
      // st.shake の既定は 0 なので、shake を書かない呼び手の挙動は従来と同一
      const swing =
        Math.max(0, Math.abs(st.av) - T.meterThreshold) * T.meterGain;
      const shake = Math.max(0, st.shake - T.shakeThreshold) * T.shakeGain;
      st.fizzMeter += (swing + shake) * dt;
    }
    // 前兆: メーターが上がるほど泡が増える (§2.3-1)
    if (
      st.fizzMeter > T.meterForeshadow &&
      st.bubbles.length < bubbleCap * 4 &&
      rand(rng) < st.fizzMeter * 0.8
    ) {
      const bx = rand(rng) * W;
      st.bubbles.push(
        makeBubble(
          W,
          H,
          rng,
          bx,
          surfaceYAt(st, bx, W, H, reduced) + 10 + rand(rng) * H * 0.5
        )
      );
    }
    if (st.fizzMeter >= 1) {
      st.fizzState = 1;
      st.foamEdge = H + T.fizzStartOvershoot;
      st.foamAlpha = 1;
      st.foamScroll = 0;
      st.hapticFizz = true;
    }
  } else if (st.fizzState === 1) {
    // 前線が一定速度で上昇して画面を覆う (§2.3-2)
    st.foamEdge -= fizzV * dt;
    st.foamScroll += fizzV * dt;
    if (st.bubbles.length < bubbleCap * 5 && rand(rng) < 0.9) {
      st.bubbles.push(makeBubble(W, H, rng));
    }
    if (st.foamEdge <= -T.fizzCoverOvershoot) {
      st.fizzState = 2;
      st.foamAlpha = 1;
    }
  } else {
    // 覆い切ったら同じ上昇速度感のままフェード (§2.3-3):
    //   α減少率 = 前線速度 / 画面高 → 消え切る時間 = H / fizzV (速度連続性)
    st.foamScroll += fizzV * dt;
    st.foamAlpha -= (fizzV / H) * dt;
    if (st.foamAlpha <= 0) {
      st.foamAlpha = 0;
      st.fizzState = 0;
      st.fizzMeter = 0;
      st.fizzCooldown = T.fizzCooldown; // §2.3-4
      while (st.bubbles.length > bubbleCap) st.bubbles.shift();
    }
  }

  // ── スロッシュ定在波 (角加速度で励起) ──
  const s1acc =
    -T.sloshOmega * T.sloshOmega * st.s1 -
    2 * T.sloshZeta * T.sloshOmega * st.s1v -
    acc * W * T.sloshDrive * (reduced ? 0.35 : 1);
  st.prevS1v = st.s1v;
  st.s1v += s1acc * dt;
  st.s1 += st.s1v * dt;
  const s1max = H * T.sloshMaxRatio;
  if (st.s1 > s1max) {
    st.s1 = s1max;
    st.s1v = Math.min(st.s1v, 0);
  }
  if (st.s1 < -s1max) {
    st.s1 = -s1max;
    st.s1v = Math.max(st.s1v, 0);
  }

  // ── 8.48: 第 2 モード (対称、中央が腹) ──
  // 励起は 1 次モードとの非線形結合 s1*s1v のみ。この積は **2ω₁ で振動**するので、
  // ω₂ = 2ω₁ に置くと「大きく左右に振った時だけ」共鳴して立つ (浅水スロッシングの
  // 2:1 内部共鳴と同じ理屈)。狙いどおり、大振幅時に面が曲がりシーソー感が消える。
  //
  // NOTE: st.shake (8.47) は励起に使わない。|a| は常に非負なので定常力になり、
  // 定在波を立てずに中央を静的にずらすだけで物理的に誤り (振れば結局 s1 が立ち、
  // この結合経由で 2 次モードも立つので実害もない)。
  const w2 = T.sloshOmega * T.slosh2Ratio;
  const excite = reduced ? 0.35 : 1;
  const s2acc =
    -w2 * w2 * st.s2 -
    2 * T.slosh2Zeta * w2 * st.s2v -
    ((T.slosh2Couple * st.s1 * st.s1v) / H) * excite;
  st.s2v += s2acc * dt;
  st.s2 += st.s2v * dt;
  const s2max = H * T.slosh2MaxRatio;
  if (st.s2 > s2max) {
    st.s2 = s2max;
    st.s2v = Math.min(st.s2v, 0);
  }
  if (st.s2 < -s2max) {
    st.s2 = -s2max;
    st.s2v = Math.max(st.s2v, 0);
  }

  // 揺り戻しの頂点 (s1v の符号反転) で「ちゃぷん」ハプティクス (cooldown 付き)
  if (
    !reduced &&
    st.prevS1v * st.s1v < 0 &&
    Math.abs(st.s1) > H * T.hapticSloshMin &&
    st.t - st.lastSloshHapticT > T.hapticCooldownS
  ) {
    st.hapticSlosh = true;
    st.lastSloshHapticT = st.t;
  }

  // ── 壁際の飛沫 ──
  if (!reduced) {
    if (
      Math.abs(st.s1v) > T.dropletSpawnVel &&
      st.droplets.length < dropletCap &&
      rand(rng) < dt * T.dropletSpawnRate
    ) {
      const wallX = st.s1v < 0 ? 3 : W - 3;
      const sy = surfaceYAt(st, wallX, W, H, reduced);
      const ux = Math.sin(st.angle);
      const uy = -Math.cos(st.angle);
      const sp = 90 + rand(rng) * 160;
      st.droplets.push({
        x: wallX,
        y: sy - 2,
        vx: ux * sp + (wallX < W / 2 ? 1 : -1) * (20 + rand(rng) * 60),
        vy: uy * sp,
        r: 1.5 + rand(rng) * 2.5,
        life: 1,
      });
    }
    const gx = -Math.sin(st.angle) * T.dropletGravity;
    const gy = Math.cos(st.angle) * T.dropletGravity;
    for (let i = st.droplets.length - 1; i >= 0; i--) {
      const p = st.droplets[i]!;
      p.vx += gx * dt;
      p.vy += gy * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * T.dropletLifeDecay;
      if (p.life <= 0 || p.y > surfaceYAt(st, p.x, W, H, reduced) + 8) {
        st.droplets.splice(i, 1);
      }
    }
  }

  // ── 泡: 重力の逆方向 (世界座標の上) へ (§2.2 — 最重要の嘘) ──
  const ux = Math.sin(st.angle);
  const uy = -Math.cos(st.angle);
  for (let i = 0; i < st.bubbles.length; i++) {
    const b = st.bubbles[i]!;
    b.w += dt * 3;
    b.x += (ux * b.s + Math.sin(b.w) * T.bubbleWiggle) * dt;
    b.y += uy * b.s * dt;
    if (
      b.y < surfaceYAt(st, b.x, W, H, reduced) + 3 ||
      b.x < -20 ||
      b.x > W + 20
    ) {
      // 液面到達 / 画面外 → 底の帯で再生成
      b.x = rand(rng) * W;
      b.y = H - rand(rng) * 40;
      b.r = 1.2 + rand(rng) * 2.6;
    }
  }
}
