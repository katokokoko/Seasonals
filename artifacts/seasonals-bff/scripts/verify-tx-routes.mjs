#!/usr/bin/env node
/**
 * verify-tx-routes — 全 protocol の tx 構築を headless で総点検する (Phase 8.50)
 *
 * 各 route に実 registry 値を投げて tx を組ませ、返ってきた base64 tx を
 * **mainnet に対して simulateTransaction** する。`sigVerify:false` +
 * `replaceRecentBlockhash:true` なので **署名も資金移動も発生しない**。
 *
 * これで分かること (実機・実資金なしで):
 *   - account 解決 / registry の鮮度 / SDK ドリフト / program の受理可否
 * これで分からないこと (実機が要る):
 *   - MWA の部分署名保持、複数 tx の 1 承認署名、実際の broadcast/confirm
 *
 * 前提: BFF が起動していること (pnpm --filter @seasonals/bff dev) と、
 * .env の HELIUS_API_KEY (simulate 用 mainnet RPC に使う)。
 * SOLANA_RPC_URL は自律実行のハードガードで devnet 固定なので**使わない** —
 * devnet に mainnet の tx を投げると ALT 不在で invalid transaction になる。
 *
 * 使い方:
 *   node scripts/verify-tx-routes.mjs [--wallet <pubkey>]
 *
 * 終了コード: 想定外の失敗が 1 件でもあれば 1 (CI 可能)。
 * 「残高が無い / ポジションが無い / 満期前」は **想定内** として扱う (EXPECTED 参照)。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = Object.fromEntries(
  fs
    .readFileSync(path.join(HERE, "..", ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const BFF = process.env.BFF_BASE_URL ?? "http://localhost:3030";
const RPC = `https://mainnet.helius-rpc.com/?api-key=${ENV.HELIUS_API_KEY}`;
const argIdx = process.argv.indexOf("--wallet");
const WALLET =
  argIdx > -1 ? process.argv[argIdx + 1] : "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

// 実 registry 由来の値 (lib/config/*.ts と同期。ずれたらここが落ちる = 鮮度検知)
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CASES = [
  ["jupiter-lend deposit", "/protocols/jupiter-lend/deposit-tx", { inputMint: USDC, amount: "1000000" }],
  ["jupiter-lend withdraw", "/protocols/jupiter-lend/withdraw-tx", { jlMint: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", amount: "1000000" }],
  ["swap-earn dep jito", "/protocols/swap-earn/deposit-tx", { shareMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", amount: "10000000" }],
  ["swap-earn wdr jito", "/protocols/swap-earn/withdraw-tx", { shareMint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", amount: "10000000" }],
  ["swap-earn dep marinade", "/protocols/swap-earn/deposit-tx", { shareMint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", amount: "10000000" }],
  ["swap-earn dep sanctum", "/protocols/swap-earn/deposit-tx", { shareMint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", amount: "10000000" }],
  ["swap-earn dep perena", "/protocols/swap-earn/deposit-tx", { shareMint: "BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6", amount: "1000000" }],
  ["swap-earn dep solstice", "/protocols/swap-earn/deposit-tx", { shareMint: "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC", amount: "1000000" }],
  ["swap-earn dep hyloSOL", "/protocols/swap-earn/deposit-tx", { shareMint: "hy1oXYgrBW6PVcJ4s6s2FKavRdwgWTXdfE69AxT7kPT", amount: "10000000" }],
  ["swap-earn dep sHYUSD", "/protocols/swap-earn/deposit-tx", { shareMint: "HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz", amount: "1000000" }],
  ["kamino dep USDC", "/protocols/kamino/deposit-tx", { reserve: "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59", amount: "1000000" }],
  ["kamino dep SOL", "/protocols/kamino/deposit-tx", { reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q", amount: "10000000" }],
  ["kamino dep JLP", "/protocols/kamino/deposit-tx", { reserve: "EAA3VVsxUuQB1Tm5x7TJkq9ATtiX5Qwq8ok7gXwim7oo", amount: "1000000" }],
  ["kamino wdr USDC", "/protocols/kamino/withdraw-tx", { reserve: "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59", amount: "1000000" }],
  ["kamino vault dep", "/protocols/kamino/vault-deposit-tx", { vault: "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E", amount: "1000000" }],
  ["kamino vault wdr", "/protocols/kamino/vault-withdraw-tx", { vault: "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E", amount: "1000000" }],
  ["save dep USDC", "/protocols/save/deposit-tx", { reserve: "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw", amount: "1000000" }],
  ["save wdr cUSDC", "/protocols/save/withdraw-tx", { ctokenMint: "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk", amount: "1000000" }],
  ["meteora dep DLMM", "/protocols/meteora/deposit-tx", { poolKey: "meteora_usdc_usdt_dlmm", amount: "1000000" }],
  ["meteora wdr", "/protocols/meteora/withdraw-tx", { position: "ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq", amount: "999999999999" }],
  ["orca dep whirlpool", "/protocols/orca/deposit-tx", { poolKey: "orca_usdc_usdt_whirlpool", amount: "2000000" }],
  ["orca wdr", "/protocols/orca/withdraw-tx", { position: "4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4", amount: "999999999999" }],
  ["exponent redeem PT", "/protocols/exponent/redeem-tx", { ptMint: "Af4kuyVwhoWK91YcsaoRQE4YbSknuWjwVM4xet7hRHB6", amount: "5000000" }],
];

/**
 * 「テスト用ウォレットに残高/ポジションが無い」ことに起因する想定内の失敗。
 * ここに当たるものは PASS 扱い (tx が組めて program に到達した = 配線は正しい)。
 */
const EXPECTED = [
  { match: /position_not_found/, why: "ポジション未保有 (BFF が 400 で弾く正しい挙動)" },
  { match: /not_matured/, why: "満期前 (Exponent は満期後のみ redeem 可)" },
  // 8.53: 上流の 400 を BFF が position_not_found に翻訳するので、文言ではなく
  // code で判定する (翻訳前の生メッセージも残す — 未翻訳の経路が出たら気付ける)
  { match: /obligation does not exist/, why: "Kamino のポジション未保有 (生の上流メッセージ)" },
  { match: /AccountNotInitialized/, why: "share/cToken の ATA 未作成 (= 未保有)" },
  { match: /InvalidAccountData/, why: "cToken 未保有" },
  { match: /Custom":6025/, why: "Jupiter: 交換元トークン未保有" },
  { match: /DepositLimitExceeded/, why: "リザーブが預入上限 (on-chain の実状況、我々の不具合ではない)" },
  // 8.51: 上流が「組めるが必ず失敗する tx」を返した場合に BFF が署名前に弾く。
  // ユーザーに doomed な tx を渡さない = 正しい挙動なので想定内に分類する
  {
    match: /deposit_cap_reached/,
    why: "預入停止中のリザーブを署名前に 409 で拒否 (8.51 のガードが作動)",
  },
  {
    match: /would fail on-chain|deposit_would_fail/,
    why: "上流が失敗する tx を返したので署名前に拒否 (8.51 のガードが作動)",
  },
  {
    match: /deposit_unavailable/,
    why: "registry で預入を塞いだ market (上流の誤ルーティング、8.52)",
  },
];

/**
 * 8.52: K-Lend Reserve 口座の **レイアウト drift 検知**。
 *
 * `fetchKaminoDepositCaps` は offset 5016 を deposit_limit として読む。凍結した
 * fixture では上流の構造体変更を検知できないので、**実 mainnet を読む**このハーネスが
 * 唯一の検知点になる。口座サイズが変わる / 既知の非ゼロ上限が 0 になったら要調査。
 */
const RESERVE_SIZE = 8624;
const DEPOSIT_LIMIT_OFFSET = 5016;
const DRIFT_RESERVES = [
  ["USDC", "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59", true], // 上限 1.0B
  ["SOL", "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q", true], // 上限 10M
  ["JLP", "EAA3VVsxUuQB1Tm5x7TJkq9ATtiX5Qwq8ok7gXwim7oo", false], // 0 = 停止中 (正当)
];

async function checkReserveLayout() {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [DRIFT_RESERVES.map(([, addr]) => addr), { encoding: "base64" }],
    }),
  });
  const j = await r.json();
  const values = j.result?.value;
  if (!Array.isArray(values)) return ["reserve layout: RPC 応答が不正"];
  const problems = [];
  DRIFT_RESERVES.forEach(([sym, , mustBeNonZero], i) => {
    const data = values[i]?.data?.[0];
    if (!data) return problems.push(`${sym}: 口座を取得できない`);
    const buf = Buffer.from(data, "base64");
    if (buf.length !== RESERVE_SIZE) {
      return problems.push(
        `${sym}: 口座サイズ ${buf.length} (期待 ${RESERVE_SIZE}) — レイアウト変更の疑い`
      );
    }
    const limit = buf.readBigUInt64LE(DEPOSIT_LIMIT_OFFSET);
    console.log(`         ${sym.padEnd(4)} size=${buf.length} deposit_limit=${limit}`);
    if (mustBeNonZero && limit === 0n) {
      problems.push(`${sym}: deposit_limit が 0 — offset ずれ or 実際に停止`);
    }
  });
  return problems;
}

async function run(name, route, extra) {
  const body = { user: WALLET, ...extra };
  let res;
  try {
    res = await fetch(BFF + route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { name, ok: false, detail: `BFF 未起動? ${e.message}` };
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { name, ok: false, detail: `HTTP ${res.status} ${j.error ?? ""} ${j.message ?? ""}`.trim() };
  }
  // route ごとに tx のキーが違う (transaction / swapTransaction / transactions[])
  const txs = j.transactions ?? [j.transaction, j.swapTransaction].filter(Boolean);
  if (!txs.length) return { name, ok: false, detail: "tx が返らない" };

  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [txs[0], { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const sim = await r.json();
  if (sim.error) return { name, ok: false, txCount: txs.length, detail: `RPC: ${JSON.stringify(sim.error).slice(0, 140)}` };
  const v = sim.result?.value ?? {};
  if (!v.err) return { name, ok: true, txCount: txs.length, units: v.unitsConsumed };
  const logs = (v.logs ?? []).join(" ");
  return { name, ok: false, txCount: txs.length, detail: `${JSON.stringify(v.err)} ${logs.slice(-400)}` };
}

const results = [];
for (const c of CASES) results.push(await run(...c));

let unexpected = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`OK       ${r.name.padEnd(22)} tx${r.txCount} CU${r.units}`);
    continue;
  }
  const hit = EXPECTED.find((e) => e.match.test(r.detail ?? ""));
  if (hit) {
    console.log(`想定内   ${r.name.padEnd(22)} ${hit.why}`);
  } else {
    unexpected++;
    console.log(`要調査   ${r.name.padEnd(22)} ${(r.detail ?? "").slice(0, 200)}`);
  }
}
// 8.52: reserve レイアウトの drift 検知 (mainnet を実際に読む)
console.log("\nKamino reserve layout (8.52 drift check)");
const layoutProblems = await checkReserveLayout().catch((e) => [
  `layout check 失敗: ${e.message}`,
]);
for (const p of layoutProblems) console.log(`要調査   ${p}`);
unexpected += layoutProblems.length;

console.log(
  `\n合計 ${results.length} 経路 / simulate 成功 ${results.filter((r) => r.ok).length} / 想定内の失敗 ${
    results.filter((r) => !r.ok).length - (unexpected - layoutProblems.length)
  } / 要調査 ${unexpected}`
);
process.exit(unexpected > 0 ? 1 : 0);
