/**
 * find-eth-demo-addresses.mjs — mainnet で実際にイベントを持つ公開 address を探す
 * (架空データを使わずに Pendle / Ethena / Lido の経路を検証するため)。
 *   node scripts/find-eth-demo-addresses.mjs
 * RPC は .env の INFURA_API_KEY / ETHEREUM_RPC_URL。出力は address と件数のみ (key は出さない)。
 */
import "dotenv/config";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { mainnet } from "viem/chains";

const url = process.env.ETHEREUM_RPC_URL || `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`;
const c = createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 2 }) });
const redact = (e) => String(e?.shortMessage ?? e?.message ?? e).split(process.env.INFURA_API_KEY ?? "\u0000").join("<redacted>").slice(0, 200);
const latest = await c.getBlockNumber();

async function logsBack(params, span, chunk = 5000n) {
  const out = [];
  for (let to = latest; to > latest - span; to -= chunk) {
    const from = to - chunk + 1n;
    try {
      out.push(...(await c.getLogs({ ...params, fromBlock: from, toBlock: to })));
    } catch (e) {
      console.error("getLogs failed", redact(e));
    }
  }
  return out;
}

// Ethena: cooldownShares/Assets は silo への ERC-4626 Withdraw を emit する
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const silo = await c.readContract({ address: SUSDE, abi: parseAbi(["function silo() view returns (address)"]), functionName: "silo" });
const wLogs = await logsBack(
  { address: SUSDE, event: parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)"), args: { receiver: silo } },
  20000n
);
const ethenaOwners = [...new Set(wLogs.map((l) => l.args.owner))];
const ethena = [];
for (const o of ethenaOwners.slice(-40)) {
  const [end, amt] = await c.readContract({ address: SUSDE, abi: parseAbi(["function cooldowns(address) view returns (uint104,uint152)"]), functionName: "cooldowns", args: [o] });
  if (amt > 0n) ethena.push({ owner: o, cooldownEnd: new Date(Number(end) * 1000).toISOString(), usde: (amt / 10n ** 18n).toString() });
}
console.log("ETHENA active cooldowns:", ethena.slice(0, 6));

// Lido: WithdrawalRequested → status
const WQ = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
const wqAbi = parseAbi([
  "struct S { uint256 amountOfStETH; uint256 amountOfShares; address owner; uint256 timestamp; bool isFinalized; bool isClaimed; }",
  "function getWithdrawalStatus(uint256[] ids) view returns (S[])",
]);
const rLogs = await logsBack(
  { address: WQ, event: parseAbiItem("event WithdrawalRequested(uint256 indexed requestId, address indexed requestor, address indexed owner, uint256 amountOfStETH, uint256 amountOfShares)") },
  60000n
);
const ids = rLogs.map((l) => l.args.requestId);
const statuses = [];
for (let i = 0; i < ids.length; i += 200) statuses.push(...(await c.readContract({ address: WQ, abi: wqAbi, functionName: "getWithdrawalStatus", args: [ids.slice(i, i + 200)] })));
const pending = statuses.filter((s) => !s.isFinalized).map((s, i) => s.owner);
const claimable = statuses.filter((s) => s.isFinalized && !s.isClaimed).map((s) => s.owner);
console.log("LIDO requests scanned:", ids.length, "pending owners:", [...new Set(pending)].slice(0, 5), "claimable owners:", [...new Set(claimable)].slice(0, 5));
