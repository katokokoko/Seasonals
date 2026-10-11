/**
 * Phase C: portfolio/inputs-store — history 入力の volume 永続化
 * (persistence.test.ts と同じく SEASONALS_DATA_DIR を mkdtemp に向ける)
 */
import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";

import { listJson } from "../persistence";
import type { HistoryInputs } from "./engine";
import {
  INPUTS_FILE_PREFIX,
  createInputsStore,
  deserializeInputs,
  serializeInputs,
} from "./inputs-store";

const DAY = 86_400;
const NOW_MS = 1_780_000_000_000;
const NOW = NOW_MS / 1000;
const WSOL = "So11111111111111111111111111111111111111112";
const addr = () => Keypair.generate().publicKey.toBase58();

function inputs(overrides: Partial<HistoryInputs> = {}): HistoryInputs {
  return {
    current: new Map([[WSOL, 5n]]),
    assets: [{ mint: WSOL, symbol: "SOL", decimals: 9 }],
    deltas: [
      { timestamp: NOW - 2 * DAY, mint: WSOL, amount: 9007199254740993n }, // 2^53 + 1
      { timestamp: NOW - DAY, mint: WSOL, amount: -5000n },
    ],
    oldestSeen: NOW - 20 * DAY,
    fetchedDays: 30,
    complete: true,
    newestSignature: "SIG_NEW",
    ...overrides,
  };
}

const savedEnv = process.env.SEASONALS_DATA_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seasonals-inputs-"));
  process.env.SEASONALS_DATA_DIR = dir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.SEASONALS_DATA_DIR;
  else process.env.SEASONALS_DATA_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("inputs-store", () => {
  it("round-trips deltas (bigint ↔ string) + cursor, without current / assets", () => {
    const store = createInputsStore({ now: () => NOW_MS });
    const a = addr();
    store.persist(a, inputs());
    const file = JSON.parse(readFileSync(join(dir, `${INPUTS_FILE_PREFIX}${a}.json`), "utf8"));
    expect(file.deltas[1].amount).toBe("9007199254740993");
    expect(file).not.toHaveProperty("current");
    expect(file).not.toHaveProperty("assets");

    const back = createInputsStore().hydrate(a);
    expect(back).toEqual({
      deltas: [
        { timestamp: NOW - DAY, mint: WSOL, amount: -5000n },
        { timestamp: NOW - 2 * DAY, mint: WSOL, amount: 9007199254740993n },
      ],
      oldestSeen: NOW - 20 * DAY,
      fetchedDays: 30,
      complete: true,
      newestSignature: "SIG_NEW",
    });
  });

  it("no-op without SEASONALS_DATA_DIR, and rejects non-address names", () => {
    const store = createInputsStore();
    store.persist("../../etc/passwd", inputs());
    expect(listJson("")).toEqual([]);
    delete process.env.SEASONALS_DATA_DIR;
    const a = addr();
    store.persist(a, inputs());
    expect(store.hydrate(a)).toBeNull();
  });

  it("writes at most every 30s per wallet; the latest skipped state is written later", () => {
    let clock = NOW_MS;
    const store = createInputsStore({ now: () => clock });
    const a = addr();
    store.persist(a, inputs({ newestSignature: "S1" }));
    clock += 10_000;
    store.persist(a, inputs({ newestSignature: "S2" }));
    expect(store.hydrate(a)!.newestSignature).toBe("S1");
    clock += 25_000;
    store.persist(addr(), inputs()); // 他 wallet の persist で期限の来た保留分も書く
    expect(store.hydrate(a)!.newestSignature).toBe("S2");
    store.persist(a, inputs({ newestSignature: "S3" }));
    store.flush();
    expect(store.hydrate(a)!.newestSignature).toBe("S3");
  });

  it("caps deltas per wallet: keeps the newest, narrows oldestSeen / fetchedDays, complete = false", () => {
    const deltas = Array.from({ length: 5 }, (_, i) => ({
      timestamp: NOW - (i + 1) * DAY,
      mint: WSOL,
      amount: BigInt(i + 1),
    }));
    const s = serializeInputs(inputs({ deltas }), NOW_MS, 3);
    expect(s.deltas.map((d) => d.amount)).toEqual(["1", "2", "3"]);
    expect(s.oldestSeen).toBe(NOW - 3 * DAY);
    expect(s.fetchedDays).toBe(3);
    expect(s.complete).toBe(false);
    // 上限内なら変えない
    const t = serializeInputs(inputs({ deltas }), NOW_MS, 10);
    expect([t.oldestSeen, t.fetchedDays, t.complete]).toEqual([NOW - 20 * DAY, 30, true]);
  });

  it("prunes the least recently written wallets beyond maxWallets", () => {
    let clock = NOW_MS;
    const store = createInputsStore({ maxWallets: 2, now: () => clock });
    const [a, b, c] = [addr(), addr(), addr()];
    store.persist(a, inputs());
    store.persist(b, inputs());
    // mtime を明示 (同 ms 書き込みの順序に依存しない)
    utimesSync(join(dir, `${INPUTS_FILE_PREFIX}${a}.json`), new Date(1000), new Date(1000));
    utimesSync(join(dir, `${INPUTS_FILE_PREFIX}${b}.json`), new Date(2000), new Date(2000));
    clock += 1;
    store.persist(c, inputs());
    expect(listJson(INPUTS_FILE_PREFIX).map((f) => f.name).sort()).toEqual(
      [`${INPUTS_FILE_PREFIX}${b}`, `${INPUTS_FILE_PREFIX}${c}`].sort()
    );
    expect(store.hydrate(a)).toBeNull();
  });

  it("ignores corrupt / foreign-shaped files", () => {
    expect(deserializeInputs({ v: 2 })).toBeNull();
    expect(
      deserializeInputs({ v: 1, fetchedDays: 1, oldestSeen: 1, complete: true, deltas: [{ mint: "M", timestamp: 1, amount: "1.5" }] })
    ).toBeNull();
    expect(deserializeInputs(null)).toBeNull();
  });
});
