/**
 * verify-oracle-feeds — §4.6 oracle gate の source を mainnet で読み、鮮度と乖離を一覧する (読み取りのみ)。
 *
 * lib/config/oracle-feeds.ts の tier A / B / C 全 asset について、Pyth sponsored push と RedStone push の
 * account を Helius で読み、BFF と同じ decoder (src/clients/oracle-onchain.ts) で価格と age を出す。
 * tier B は RedStone gateway の package を BFF と同じ検証 (src/clients/oracle-redstone-gateway.ts) に通し、
 * 有効 signer 数 / 中央値 / age を出す。
 * sponsor が止まった feed (2026-10 に USDS / USX で実際に起きた) を、Menu で踏む前に見つけるための script。
 *
 *   pnpm --filter @seasonals/bff verify:oracle
 *
 * 終了コード: 設定済みの source が閾値 (Pyth 75 秒 (feed 別上書きあり) / RedStone push 90 秒 / gateway 60 秒)
 * を超えて stale、decode できない、gateway の signer quorum 不足、または乖離が 5% を超えたら 1。1 回の読み取りで heartbeat の谷に当たることがあるので、
 * stale は 3 回まで読み直してから判定する。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ORACLE_FEEDS,
  PYTH_PUSH_MAX_AGE_S,
  REDSTONE_GATEWAY_MAX_AGE_S,
  REDSTONE_GATEWAY_MIN_SIGNERS,
  REDSTONE_PRIMARY_SIGNERS,
  REDSTONE_PUSH_MAX_AGE_S,
} from "@workspace/lib/config/oracle-feeds";
import { aggregateGatewayFeed, fetchGatewaySnapshot, type GatewayAggregate } from "../src/clients/oracle-redstone-gateway";
import { getMultipleAccountsBase64 } from "../src/clients/helius-rpc";
import {
  decodePythPriceUpdate,
  decodeRedstonePriceData,
  pythPushAccount,
  redstonePriceAccount,
  type DecodedPrice,
} from "../src/clients/oracle-onchain";

if (!process.env.HELIUS_API_KEY) {
  const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const m = /^HELIUS_API_KEY=(.*)$/m.exec(env);
  if (m) process.env.HELIUS_API_KEY = m[1]!.trim();
}

interface Row {
  symbol: string;
  tier: string;
  pythMaxAgeS: number;
  pyth?: { account: string; decoded: DecodedPrice };
  redstone?: { account: string; decoded: DecodedPrice };
  gateway?: GatewayAggregate;
}

async function readAll(): Promise<Row[]> {
  const rows: Row[] = [];
  const keys: string[] = [];
  for (const f of Object.values(ORACLE_FEEDS)) {
    if (f.tier === "D") continue;
    const row: Row = { symbol: f.symbol, tier: f.tier, pythMaxAgeS: f.pythMaxAgeS ?? PYTH_PUSH_MAX_AGE_S };
    if (f.pythFeedId) keys.push(pythPushAccount(f.pythFeedId));
    if (f.redstoneFeedId) keys.push(redstonePriceAccount(f.redstoneFeedId));
    rows.push(row);
  }
  const [accts, snap] = await Promise.all([
    getMultipleAccountsBase64(keys),
    Object.values(ORACLE_FEEDS).some((f) => f.redstoneGatewayFeedId) ? fetchGatewaySnapshot() : Promise.resolve({}),
  ]);
  const byKey = new Map(keys.map((k, i) => [k, accts[i] ?? null]));
  for (const row of rows) {
    const f = Object.values(ORACLE_FEEDS).find((x) => x.symbol === row.symbol)!;
    if (f.pythFeedId) {
      const account = pythPushAccount(f.pythFeedId);
      row.pyth = { account, decoded: decodePythPriceUpdate(byKey.get(account) ?? null, f.pythFeedId) };
    }
    if (f.redstoneFeedId) {
      const account = redstonePriceAccount(f.redstoneFeedId);
      row.redstone = { account, decoded: decodeRedstonePriceData(byKey.get(account) ?? null, f.redstoneFeedId) };
    }
    if (f.redstoneGatewayFeedId) row.gateway = await aggregateGatewayFeed((snap as Record<string, never>)[f.redstoneGatewayFeedId], f.redstoneGatewayFeedId);
  }
  return rows;
}

const now = () => Math.floor(Date.now() / 1000);
const age = (d: DecodedPrice) => (d.ok ? now() - d.publishTimeSec : null);
const isStale = (d: DecodedPrice | undefined, max: number) => d !== undefined && (!d.ok || (age(d) ?? Infinity) > max);

function problems(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.pyth && isStale(r.pyth.decoded, r.pythMaxAgeS)) out.push(`${r.symbol} pyth`);
    if (r.redstone && isStale(r.redstone.decoded, REDSTONE_PUSH_MAX_AGE_S)) out.push(`${r.symbol} redstone`);
    if (r.gateway && (!r.gateway.status.available || (r.gateway.status.age_seconds ?? Infinity) > REDSTONE_GATEWAY_MAX_AGE_S)) {
      out.push(`${r.symbol} gateway`);
    }
  }
  return out;
}

async function main() {
  let rows = await readAll();
  // heartbeat の谷 (Pyth 55 秒 + 着地待ち) に当たっただけの stale は、少し待って読み直す
  for (let i = 0; i < 2 && problems(rows).length > 0; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    rows = await readAll();
  }

  let unexpected = 0;
  console.log(
    `閾値: Pyth push ${PYTH_PUSH_MAX_AGE_S}s (feed 別上書きあり) / RedStone push ${REDSTONE_PUSH_MAX_AGE_S}s / gateway ${REDSTONE_GATEWAY_MAX_AGE_S}s` +
      ` (signer ${REDSTONE_GATEWAY_MIN_SIGNERS}/${REDSTONE_PRIMARY_SIGNERS.length} 以上) / 乖離 block 5%\n`
  );
  for (const r of rows) {
    const cell = (s: Row["pyth"], max: number) => {
      if (!s) return "-".padEnd(26);
      if (!s.decoded.ok) return `NG ${s.decoded.reason}`.slice(0, 26).padEnd(26);
      const a = age(s.decoded)!;
      return `${s.decoded.price_usd} (${a}s${a > max ? " STALE" : ""})`.padEnd(26);
    };
    let div = "";
    const secondaryPrice = r.redstone?.decoded.ok ? r.redstone.decoded.price_usd : r.gateway?.status.price_usd ?? null;
    if (r.pyth?.decoded.ok && secondaryPrice) {
      const a = Number(r.pyth.decoded.price_usd);
      const b = Number(secondaryPrice);
      const pct = (Math.abs(a - b) / ((a + b) / 2)) * 100;
      div = `乖離 ${pct.toFixed(3)}%`;
      if (pct > 5) {
        unexpected++;
        div += " >5%";
      }
    }
    const bad = problems([r]);
    unexpected += bad.length;
    const second = r.gateway
      ? `gateway ${(r.gateway.status.available ? `${r.gateway.status.price_usd} (${r.gateway.status.age_seconds}s, ${r.gateway.validSigners}/${REDSTONE_PRIMARY_SIGNERS.length} signers)` : `NG ${r.gateway.reason ?? ""}`).padEnd(26)}`
      : `redstone ${cell(r.redstone, REDSTONE_PUSH_MAX_AGE_S)}`;
    console.log(`${bad.length ? "要調査" : "OK    "}   ${r.symbol.padEnd(8)} tier ${r.tier}  pyth ${cell(r.pyth, r.pythMaxAgeS)} ${second} ${div}`);
  }
  console.log("\ntier D (gate 対象外):");
  for (const f of Object.values(ORACLE_FEEDS)) if (f.tier === "D") console.log(`想定内   ${f.symbol.padEnd(9)} ${f.reason}`);
  console.log(`\n合計 ${rows.length} asset / 要調査 ${unexpected}`);
  process.exit(unexpected > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-oracle-feeds 失敗:", String((e as Error).message).replace(/api-key=[^&\s]+/g, "api-key=***"));
  process.exit(1);
});
