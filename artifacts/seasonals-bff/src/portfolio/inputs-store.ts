/**
 * portfolio/inputs-store — `/portfolio/history` の入力 (tx 差分 + cursor) を Fly volume に保存する (Phase C)
 *
 * 履歴 engine (portfolio/engine.ts) の入力 cache は memory だけなので、deploy / 再起動のたびに
 * 全 wallet が cold (Parsed Events で最大 10 page を取り直し) になる。ここで wallet ごとに
 * `history-inputs.<wallet>.json` (persistence.ts、`SEASONALS_DATA_DIR`) へ保存し、再起動後は
 * engine の `hydrate` で **期限切れの前回分** として戻す → 次の load は `afterSignature` の増分
 * (通常 1 page = 10 credit) で済む。
 *
 * 保存するのは増分の起点だけ: `{mint, timestamp, amount}` の差分 + `fetchedDays / oldestSeen /
 * complete / newestSignature`。現在残高・単価 (`current` / `assets`) は毎回 DAS から読み直すので
 * 保存しない。amount は bigint → string (§4.5)。
 *
 * 上限:
 * - wallet あたり 1,000 delta (新しい方を残す)。切った時は `oldestSeen` を残した最古の delta の
 *   時刻に上げ、`complete = false`、`fetchedDays` もそこまでに縮める (それより前は「不明」になる =
 *   誤った残高は出さない)
 * - 200 wallet (書いた時に mtime の古い file から消す = LRU)
 * - 書き込みは wallet ごと 30 秒に 1 回 (間引いた分は次の persist 時に最新だけ書く。落ちても
 *   増分取得が古い cursor から取り直すだけ)
 *
 * `SEASONALS_DATA_DIR` 未設定 (jest / CI) では no-op。保存失敗は握りつぶす (best-effort)。
 */
import {
  isPersistenceEnabled,
  deleteJson,
  listJson,
  loadJson,
  saveJson,
} from "../persistence";
import type { BalanceDelta } from "../portfolio-history";
import type { HistoryInputs, HistoryInputsCursor } from "./engine";

export const INPUTS_FILE_PREFIX = "history-inputs.";
const DAY = 86_400;

/** file 名に使うので base58 の Solana address だけ受け付ける (path traversal 防止) */
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AMOUNT_RE = /^-?[0-9]+$/;

interface PersistedDelta {
  mint: string;
  timestamp: number;
  /** smallest unit、符号付き整数 string */
  amount: string;
}

interface PersistedInputsV1 {
  v: 1;
  /** 保存時刻 (ms) */
  savedAt: number;
  fetchedDays: number;
  oldestSeen: number;
  complete: boolean;
  newestSignature?: string;
  deltas: PersistedDelta[];
}

export interface InputsStoreOptions {
  /** wallet あたりの delta 上限 (既定 1,000) */
  maxDeltas?: number;
  /** 保存する wallet 数の上限 (既定 200) */
  maxWallets?: number;
  /** wallet ごとの最小書き込み間隔 (既定 30s) */
  minWriteIntervalMs?: number;
  now?: () => number;
}

export interface InputsStore {
  hydrate(address: string): HistoryInputsCursor | null;
  persist(address: string, inputs: HistoryInputs): void;
  /** 間引きで保留中の書き込みを全部書く (shutdown / test 用) */
  flush(): void;
}

function fileName(address: string): string {
  return `${INPUTS_FILE_PREFIX}${address}`;
}

/** 保存形式へ (上限超過は新しい方を残し、遡れる範囲を縮める) */
export function serializeInputs(
  inputs: HistoryInputsCursor,
  nowMs: number,
  maxDeltas: number
): PersistedInputsV1 {
  const newestFirst = [...inputs.deltas].sort((a, b) => b.timestamp - a.timestamp);
  let { oldestSeen, complete, fetchedDays } = inputs;
  let kept = newestFirst;
  if (newestFirst.length > maxDeltas) {
    kept = newestFirst.slice(0, maxDeltas);
    // 残した最古の時刻より前は不明。replayBalances は「at より新しい差分」を戻すので、
    // at >= boundary の点は残した差分だけで正しく出る
    const boundary = kept[kept.length - 1]!.timestamp;
    oldestSeen = Math.max(oldestSeen, boundary);
    complete = false;
    fetchedDays = Math.min(fetchedDays, Math.max(0, Math.floor((nowMs / 1000 - oldestSeen) / DAY)));
  }
  return {
    v: 1,
    savedAt: nowMs,
    fetchedDays,
    oldestSeen,
    complete,
    ...(inputs.newestSignature ? { newestSignature: inputs.newestSignature } : {}),
    deltas: kept.map((d) => ({ mint: d.mint, timestamp: d.timestamp, amount: d.amount.toString() })),
  };
}

/** 保存形式から。形が違えば null (破損 file は使わない) */
export function deserializeInputs(raw: unknown): HistoryInputsCursor | null {
  const r = raw as Partial<PersistedInputsV1> | null;
  if (
    !r ||
    r.v !== 1 ||
    !Array.isArray(r.deltas) ||
    typeof r.fetchedDays !== "number" ||
    typeof r.oldestSeen !== "number" ||
    typeof r.complete !== "boolean"
  ) {
    return null;
  }
  const deltas: BalanceDelta[] = [];
  for (const d of r.deltas) {
    if (
      !d ||
      typeof d.mint !== "string" ||
      typeof d.timestamp !== "number" ||
      typeof d.amount !== "string" ||
      !AMOUNT_RE.test(d.amount)
    ) {
      return null;
    }
    deltas.push({ mint: d.mint, timestamp: d.timestamp, amount: BigInt(d.amount) });
  }
  return {
    deltas,
    fetchedDays: r.fetchedDays,
    oldestSeen: r.oldestSeen,
    complete: r.complete,
    ...(typeof r.newestSignature === "string" ? { newestSignature: r.newestSignature } : {}),
  };
}

export function createInputsStore(opts: InputsStoreOptions = {}): InputsStore {
  const maxDeltas = opts.maxDeltas ?? 1000;
  const maxWallets = opts.maxWallets ?? 200;
  const minInterval = opts.minWriteIntervalMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const lastWrite = new Map<string, number>();
  const pending = new Map<string, HistoryInputs>();

  function prune(): void {
    const files = listJson(INPUTS_FILE_PREFIX);
    for (let i = 0; i < files.length - maxWallets; i++) deleteJson(files[i]!.name);
  }

  function write(address: string, inputs: HistoryInputs): void {
    const at = now();
    saveJson(fileName(address), serializeInputs(inputs, at, maxDeltas));
    lastWrite.delete(address); // 再挿入で挿入順を最新に
    lastWrite.set(address, at);
    pending.delete(address);
    // memory 側の記録も wallet 上限で抑える (古い順に落とす)
    while (lastWrite.size > maxWallets * 2) {
      const oldest = lastWrite.keys().next().value;
      if (oldest === undefined) break;
      lastWrite.delete(oldest);
    }
    prune();
  }

  function flushDue(): void {
    const at = now();
    for (const [address, inputs] of [...pending]) {
      if (at - (lastWrite.get(address) ?? 0) >= minInterval) write(address, inputs);
    }
  }

  return {
    hydrate(address) {
      if (!isPersistenceEnabled() || !ADDRESS_RE.test(address)) return null;
      return deserializeInputs(loadJson<unknown>(fileName(address)));
    },

    persist(address, inputs) {
      if (!isPersistenceEnabled() || !ADDRESS_RE.test(address)) return;
      try {
        const last = lastWrite.get(address);
        if (last !== undefined && now() - last < minInterval) {
          pending.set(address, inputs);
        } else {
          write(address, inputs);
        }
        flushDue();
      } catch {
        // best-effort
      }
    },

    flush() {
      for (const [address, inputs] of [...pending]) write(address, inputs);
    },
  };
}
