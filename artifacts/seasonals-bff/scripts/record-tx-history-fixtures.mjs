#!/usr/bin/env node
/**
 * record-tx-history-fixtures — Enhanced Transactions と Parsed Events を同じ wallet で録画する (Phase C)
 *
 * Helius Enhanced Transactions (100 credit / req) から Parsed Events (10 credit / req) へ移る前に、
 * 両 API の応答を同じ wallet / 同じ件数で取り、parity test (src/clients/helius-parsed-events.test.ts)
 * の入力にする。`accountData` (Enhanced) を `rawTransaction.meta` の pre/post balance から再構成
 * できるか (source A) を判定する材料も出す。
 *
 * 使い方 (BFF の .env の HELIUS_API_KEY を使う。BFF の起動は不要):
 *   node scripts/record-tx-history-fixtures.mjs [--wallet <pubkey>] [--limit 20]
 *
 * 出力:
 *   src/__fixtures__/helius/enhanced.<wallet先頭8>.json — Enhanced の配列 (parity に要らない
 *     instructions / events / lighthouseData は落とす)
 *   src/__fixtures__/helius/parsed.<wallet先頭8>.json  — Parsed Events の `{ data, paginationToken }`
 *     (includeRawTransaction: true。logMessages / innerInstructions / instruction の decoded・rawData
 *     は落とす)。数値は adapter と同じ quote-before-parse を通した後の形 (rawTokenAmount /
 *     nativeTransfers.amount / pre・postBalances が string)
 *
 * 秘密: api-key は URL の query にだけ載せ、fixture / log には書かない。
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
const KEY = process.env.HELIUS_API_KEY ?? ENV.HELIUS_API_KEY;
if (!KEY) {
  console.error("HELIUS_API_KEY is not set (env or artifacts/seasonals-bff/.env)");
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
// 既定は verify-tx-routes.mjs と同じ wallet
const WALLET = arg("wallet", "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM");
const LIMIT = Number(arg("limit", "20")); // 件数 (小整数、§4.5 適用外)
const OUT_DIR = path.join(HERE, "..", "src", "__fixtures__", "helius");
const TAG = WALLET.slice(0, 8);

const redact = (s) => String(s).replace(/api-key=[^&\s"']+/g, "api-key=***");

/** src/clients/helius-parsed-events.ts の quoteLargeNumbers と同じ規則 (JSON number → string) */
function quoteLargeNumbers(text) {
  const END = String.raw`(?=\s*[,}\]])`;
  return text
    .replace(new RegExp(String.raw`("rawTokenAmount"\s*:\s*)(-?\d+)` + END, "g"), '$1"$2"')
    .replace(/("nativeTransfers"\s*:\s*\[)([^\]]*)(\])/g, (_m, a, body, z) =>
      a + body.replace(new RegExp(String.raw`("amount"\s*:\s*)(-?\d+)` + END, "g"), '$1"$2"') + z
    )
    .replace(/("(?:preBalances|postBalances)"\s*:\s*\[)([^\]]*)(\])/g, (_m, a, body, z) =>
      a + body.replace(/-?\d+/g, '"$&"') + z
    );
}

async function getText(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact(text.slice(0, 200))}`);
  return text;
}

const enhancedText = await getText(
  `https://api.helius.xyz/v0/addresses/${WALLET}/transactions?api-key=${KEY}&limit=${LIMIT}`,
  { headers: { accept: "application/json" } }
).catch((e) => {
  console.error("enhanced:", redact(e.message));
  process.exit(1);
});
const parsedText = await getText(
  `https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key=${KEY}`,
  {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ address: WALLET, limit: LIMIT, includeRawTransaction: true }),
  }
).catch((e) => {
  console.error("parsed:", redact(e.message));
  process.exit(1);
});

const enhanced = JSON.parse(enhancedText).map(
  ({ instructions: _i, events: _e, lighthouseData: _l, ...rest }) => rest
);
const parsedRaw = JSON.parse(quoteLargeNumbers(parsedText));
const parsed = {
  ...parsedRaw,
  data: parsedRaw.data.map((item) => {
    const out = { ...item };
    if (item.parsed) {
      out.parsed = {
        ...item.parsed,
        instructions: (item.parsed.instructions ?? []).map((ins) => ({
          programId: ins.programId,
          programName: ins.programName,
          instructionName: ins.instructionName,
          rawAccounts: ins.rawAccounts,
        })),
      };
    }
    if (item.rawTransaction) {
      const raw = item.rawTransaction;
      const {
        logMessages: _lm,
        innerInstructions: _ii,
        returnData: _rd,
        rewards: _rw,
        ...meta
      } = raw.meta ?? {};
      out.rawTransaction = {
        blockTime: raw.blockTime,
        slot: raw.slot,
        meta,
        transaction: {
          message: {
            accountKeys: raw.transaction?.message?.accountKeys,
            header: raw.transaction?.message?.header,
          },
        },
      };
    }
    return out;
  }),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const enhancedFile = path.join(OUT_DIR, `enhanced.${TAG}.json`);
const parsedFile = path.join(OUT_DIR, `parsed.${TAG}.json`);
fs.writeFileSync(enhancedFile, JSON.stringify(enhanced, null, 1) + "\n");
fs.writeFileSync(parsedFile, JSON.stringify(parsed, null, 1) + "\n");

const withRaw = parsed.data.filter((d) => Array.isArray(d.rawTransaction?.meta?.preTokenBalances));
const enhancedSigs = new Set(enhanced.map((t) => t.signature));
const overlap = parsed.data.filter((d) => enhancedSigs.has(d.signature)).length;
const statuses = parsed.data.reduce((m, d) => ({ ...m, [d.parserStatus]: (m[d.parserStatus] ?? 0) + 1 }), {});
console.log(`wallet            ${TAG}… (limit ${LIMIT})`);
console.log(`enhanced          ${enhanced.length} tx, response ${enhancedText.length} B → fixture ${fs.statSync(enhancedFile).size} B`);
console.log(
  `parsed            ${parsed.data.length} tx (${JSON.stringify(statuses)}), paginationToken ${parsed.paginationToken ? "present" : "absent"}, response ${parsedText.length} B → fixture ${fs.statSync(parsedFile).size} B`
);
console.log(`source A possible ${withRaw.length}/${parsed.data.length} items have rawTransaction.meta.preTokenBalances`);
console.log(`signature overlap ${overlap}`);
