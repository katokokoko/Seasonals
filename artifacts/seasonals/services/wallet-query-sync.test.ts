/**
 * useWalletQuerySync — テスト (Phase 8.77)
 *
 * 固定するのは「どの遷移でクエリを取り直すか」。特に
 * **同じ wallet に繋ぎ直した時** (address が変わらない) を落とすと、
 * 実機で報告された「再接続してもグラフとカレンダーが変わらない」に戻る。
 */
import { shouldResyncWallet, WALLET_SCOPED_QUERY_KEYS } from "./wallet-query-sync";

const ADDR_A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const ADDR_B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

describe("shouldResyncWallet", () => {
  it("**同じ address でも connected に入り直したら取り直す** (再接続)", () => {
    // disconnect で idle → 同じ wallet を繋ぎ直して connected。
    // query key は元に戻るだけなので、これを拾わないとキャッシュのまま
    expect(
      shouldResyncWallet(
        { address: ADDR_A, status: "idle" },
        { address: ADDR_A, status: "connected" }
      )
    ).toBe(true);
  });

  it("別の wallet に切り替えたら取り直す", () => {
    expect(
      shouldResyncWallet(
        { address: ADDR_A, status: "connected" },
        { address: ADDR_B, status: "connected" }
      )
    ).toBe(true);
  });

  it("切断 (address が消える) でも取り直す — 前の wallet の残像を残さない", () => {
    expect(
      shouldResyncWallet(
        { address: ADDR_A, status: "connected" },
        { address: null, status: "idle" }
      )
    ).toBe(true);
  });

  it("接続中 / エラーへの遷移では取り直さない (まだ繋がっていない)", () => {
    expect(
      shouldResyncWallet(
        { address: null, status: "idle" },
        { address: null, status: "connecting" }
      )
    ).toBe(false);
    expect(
      shouldResyncWallet(
        { address: null, status: "connecting" },
        { address: null, status: "error" }
      )
    ).toBe(false);
  });

  it("何も変わっていなければ取り直さない (無駄な再取得を撒かない)", () => {
    expect(
      shouldResyncWallet(
        { address: ADDR_A, status: "connected" },
        { address: ADDR_A, status: "connected" }
      )
    ).toBe(false);
  });
});

describe("WALLET_SCOPED_QUERY_KEYS", () => {
  it("wallet 由来の 4 系統をすべて含む (履歴を落とすとグラフが 5 分固まる)", () => {
    expect([...WALLET_SCOPED_QUERY_KEYS]).toEqual([
      "positions",
      "earn-positions",
      "wallet-time-events",
      "portfolio-history",
    ]);
  });
});
