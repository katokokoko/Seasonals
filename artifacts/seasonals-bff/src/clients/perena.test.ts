/**
 * Perena Tri-Stable Pool (旧 USD* の pool) の TVL — 固定 vault を on-chain から読んで合算する。
 * fixture は 2026-10-05 に Helius で取った 3 vault の実 bytes。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERENA_TRI_STABLE_VAULTS } from "@workspace/lib/config/perena";
import type { RawAccount } from "./helius-rpc";

jest.mock("./helius-rpc", () => ({ getMultipleAccountsBase64: jest.fn() }));
import { getMultipleAccountsBase64 } from "./helius-rpc";
import { decodeVaultAmount, fetchPerenaTriStableTvlUsd } from "./perena";

const fx = JSON.parse(readFileSync(join(__dirname, "../__fixtures__/perena/tri-stable-vaults.json"), "utf8")) as {
  accounts: Array<{ address: string; owner: string; data: string }>;
};
const accounts: RawAccount[] = fx.accounts.map((a) => ({ owner: a.owner, data: Buffer.from(a.data, "base64") }));
const mocked = getMultipleAccountsBase64 as jest.MockedFunction<typeof getMultipleAccountsBase64>;

afterEach(() => mocked.mockReset());

test("3 vault (USDC / USDT / PYUSD、PYUSD は Token-2022) を decode して残高を返す", () => {
  expect(PERENA_TRI_STABLE_VAULTS.map((v, i) => decodeVaultAmount(accounts[i]!, v))).toEqual([136042700840n, 110006335116n, 60721535910n]);
});

test("合計を TVL (USD) にする", async () => {
  mocked.mockResolvedValue(accounts);
  await expect(fetchPerenaTriStableTvlUsd()).resolves.toBeCloseTo(306770.57, 2);
  expect(mocked.mock.calls[0]![0]).toEqual(PERENA_TRI_STABLE_VAULTS.map((v) => v.vault));
});

test("mint / owner / program が違う account は数えずに throw する", () => {
  const usdc = PERENA_TRI_STABLE_VAULTS[0]!;
  // USDT の vault を USDC として読ませる → mint 不一致
  expect(() => decodeVaultAmount(accounts[1]!, usdc)).toThrow(/mint mismatch/);
  // owner (pool) を書き換える
  const wrongOwner = Buffer.from(accounts[0]!.data);
  wrongOwner.fill(1, 32, 64);
  expect(() => decodeVaultAmount({ owner: accounts[0]!.owner, data: wrongOwner }, usdc)).toThrow(/owner/);
  // Token-2022 の vault を Token program として読ませる
  expect(() => decodeVaultAmount({ ...accounts[2]!, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, PERENA_TRI_STABLE_VAULTS[2]!)).toThrow(/program/);
});

test("vault が欠けていたら throw (fixture 値のまま表示させる)", async () => {
  mocked.mockResolvedValue([accounts[0]!, null, accounts[2]!]);
  await expect(fetchPerenaTriStableTvlUsd()).rejects.toThrow(/not found/);
});
