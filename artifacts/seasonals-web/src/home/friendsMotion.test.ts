import { appearance, IN_S, OUT_S, spawn, stepFriend, type Env, type FriendState } from "./friendsMotion";

function env(over: Partial<Env> = {}): Env {
  let seed = 1;
  return {
    zones: [
      { x0: 40, y0: 300, x1: 300, y1: 600 },
      { x0: 1140, y0: 300, x1: 1400, y1: 600 },
    ],
    viewport: { w: 1440, h: 900 },
    size: 100,
    pointer: null,
    busyZone: null,
    rand: () => ((seed = (seed * 16807) % 2147483647) / 2147483647),
    ...over,
  };
}
function run(s: FriendState, seconds: number, e: Env, dt = 1 / 60): FriendState {
  for (let t = 0; t < seconds; t += dt) s = stepFriend(s, dt, e);
  return s;
}

test("spawns inside the open water of the preferred zone, avoiding a busy one", () => {
  const e = env();
  const s = spawn(e, 0)!;
  expect(s.zone).toBe(0);
  expect(s.phase).toBe("in");
  expect(s.x).toBeGreaterThanOrEqual(40 + 50);
  expect(s.x).toBeLessThanOrEqual(300 - 50);
  expect(s.y).toBeGreaterThanOrEqual(300 + 50);
  expect(s.y).toBeLessThanOrEqual(600 - 50);
  expect(spawn(env({ busyZone: 0 }), 0)!.zone).toBe(1);
  expect(spawn(env({ zones: [null, null] }), 0)).toBeNull();
});

test("life cycle: surfaces, drifts slowly, sinks away, then reappears", () => {
  const e = env();
  let s = spawn(e, 0)!;
  expect(appearance(s).opacity).toBe(0);
  s = run(s, IN_S + 0.1, e);
  expect(s.phase).toBe("drift");
  expect(appearance(s)).toEqual({ opacity: 1, scale: 1 });
  const x0 = s.x;
  const y0 = s.y;
  s = run(s, 1, e);
  const speed = Math.hypot(s.x - x0, s.y - y0);
  expect(speed).toBeGreaterThan(3);
  expect(speed).toBeLessThan(12); // ゆっくり (5–11 px/s)
  s = run(s, 45, e); // drift は 20–40 秒 (画面外に出ればその前に) で終わる
  expect(["out", "away", "in", "drift"]).toContain(s.phase);
  let sawOut = false;
  let sawAway = false;
  let reappeared = false;
  let t = spawn(e, 0)!;
  for (let i = 0; i < 60 * 90; i++) {
    const prev = t.phase;
    t = stepFriend(t, 1 / 60, e);
    if (t.phase === "out") sawOut = true;
    if (t.phase === "away") sawAway = true;
    if (prev === "away" && t.phase === "in") reappeared = true;
  }
  expect(sawOut && sawAway && reappeared).toBe(true);
});

test("sinking fades out and shrinks a little", () => {
  const s: FriendState = { phase: "out", t: OUT_S / 2, x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0, life: 30, wait: 0, zone: 0 };
  const a = appearance(s);
  expect(a.opacity).toBeGreaterThan(0);
  expect(a.opacity).toBeLessThan(1);
  expect(a.scale).toBeLessThan(1);
});

test("the pointer stirs the water gently instead of making them dart away", () => {
  const e = env();
  const base = run(spawn(e, 0)!, IN_S + 0.1, e);
  // 速く振ってもすぐには跳ばない: 1 フレームで動く量はほぼ流れだけ
  const fast = { x: base.x + 30, y: base.y, vx: -3000, vy: 0 };
  const one = stepFriend(base, 1 / 60, env({ pointer: fast }));
  expect(Math.hypot(one.x - base.x, one.y - base.y)).toBeLessThan(1);
  // 押され続けても速さは上限 (流れ 11 + かき混ぜ 28 px/s) を超えない
  let s = base;
  for (let i = 0; i < 120; i++) {
    const before = s;
    s = stepFriend(s, 1 / 60, env({ pointer: { ...fast, x: s.x + 30, y: s.y } }));
    expect(Math.hypot(s.x - before.x, s.y - before.y) * 60).toBeLessThan(40);
  }
  // 手を離すと数秒でかき混ぜの分が抜けて流れに戻る
  const stirred = Math.hypot(s.px, s.py);
  expect(stirred).toBeGreaterThan(5);
  const calm = run(s, 8, e);
  expect(Math.hypot(calm.px, calm.py)).toBeLessThan(stirred * 0.1);
});
