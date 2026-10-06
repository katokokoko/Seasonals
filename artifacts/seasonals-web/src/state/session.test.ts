/**
 * session — chain ごとの接続、watchlist との重複排除、永続化する項目。
 */
import { activeAddresses, sameAddress, useSession } from "./session";

const ETH = "0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11";
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const WALLET = { name: "Phantom", icon: "", rdns: "Phantom" };

beforeEach(() => useSession.setState({ watchlist: [], connected: {}, lastSolanaWallet: null }));

test("接続 wallet を SUPPORTED_CHAINS 順に先頭にし、watchlist の同じ address は重ねない", () => {
  const out = activeAddresses({
    connected: { ethereum: { address: ETH, wallet: WALLET }, solana: { address: SOL, wallet: WALLET } },
    watchlist: [
      { chain: "ethereum", address: ETH.toLowerCase() },
      { chain: "solana", address: SOL },
    ],
  });
  expect(out).toEqual([
    { chain: "solana", address: SOL, connected: true },
    { chain: "ethereum", address: ETH, connected: true },
  ]);
});

test("Solana address は大文字小文字を区別する (base58)", () => {
  expect(sameAddress("ethereum", ETH, ETH.toLowerCase())).toBe(true);
  expect(sameAddress("solana", SOL, SOL.toLowerCase())).toBe(false);
});

test("Solana の接続で wallet 名を残し、明示的な切断で消す", () => {
  const s = useSession.getState();
  s.setConnected("solana", SOL, WALLET);
  expect(useSession.getState().lastSolanaWallet).toBe("Phantom");
  // account の切り替え (wallet 省略) は wallet をそのまま使う
  useSession.getState().setConnected("solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  expect(useSession.getState().connected.solana?.wallet.name).toBe("Phantom");
  useSession.getState().setConnected("solana", null);
  expect(useSession.getState().connected.solana).toBeUndefined();
  expect(useSession.getState().lastSolanaWallet).toBeNull();
});

test("wallet 情報なしで未接続 chain に address だけ入れることはしない", () => {
  useSession.getState().setConnected("ethereum", ETH);
  expect(useSession.getState().connected.ethereum).toBeUndefined();
});

test("永続化するのは watchlist と lastSolanaWallet だけ (接続そのものは wallet 側の許可が正)", () => {
  useSession.getState().setConnected("solana", SOL, WALLET);
  const partialize = useSession.persist.getOptions().partialize!;
  expect(Object.keys(partialize(useSession.getState()) as object).sort()).toEqual(["lastSolanaWallet", "watchlist"]);
});
