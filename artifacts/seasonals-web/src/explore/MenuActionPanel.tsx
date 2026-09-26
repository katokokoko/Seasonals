/**
 * Menu カード内の deposit / withdraw パネル。
 * 数量 → BFF /eth/menu/plan (未署名プラン、mainnet に eth_call) → PlanView → 承認で fork 実行。
 * 金額は decimal string のまま BFF へ渡し、smallest unit への変換と残高検証は BFF が on-chain で行う。
 * Max は BFF が返した残高 (smallest unit) を toHumanReadable で正確に戻したもの (Number を通さない)。
 */
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toHumanReadable } from "@workspace/lib/utils/numeric";
import type { MenuHoldingsResponse, MenuProduct, TokenAmountView } from "@workspace/lib/types";
import { api, ApiError, type MenuPlanRequest } from "../services/api";
import { PlanView, TargetBadge } from "../timeline/PlanView";
import { fmtAmount, shortAddress } from "../ui/format";

export type MenuAction = "deposit" | "withdraw";

/** 商品ごとに、入金に使うトークンと引き出せるトークン */
const TOKENS: Record<string, { deposit: string; withdraw: string[] }> = {
  "ethereum:lido:steth": { deposit: "ETH", withdraw: ["stETH", "wstETH"] },
  "ethereum:ethena:susde": { deposit: "USDe", withdraw: ["sUSDe"] },
};

/** Menu から deposit / withdraw できる商品か (Pendle は価格 guard 付きで別途対応) */
export function menuActionable(product: MenuProduct): boolean {
  return product.id in TOKENS;
}

const LABEL: Record<string, Record<MenuAction, string>> = {
  "ethereum:lido:steth": { deposit: "Stake ETH", withdraw: "Request withdrawal" },
  "ethereum:ethena:susde": { deposit: "Stake USDe", withdraw: "Start cooldown" },
};

export function actionLabel(product: MenuProduct, action: MenuAction): string {
  return LABEL[product.id]?.[action] ?? (action === "deposit" ? "Deposit" : "Withdraw");
}

function balanceOf(data: MenuHoldingsResponse | undefined, product: MenuProduct, action: MenuAction, symbol: string): TokenAmountView | undefined {
  if (!data) return undefined;
  if (action === "deposit") return data.spendable.find((a) => a.symbol === symbol);
  return data.holdings.find((h) => h.productId === product.id)?.amounts.find((a) => a.symbol === symbol);
}

const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

export function MenuActionPanel({
  product,
  action,
  addresses,
  byAddress,
  onClose,
}: {
  product: MenuProduct;
  action: MenuAction;
  /** 閲覧中の Ethereum address (watch / 接続) */
  addresses: string[];
  byAddress: Map<string, MenuHoldingsResponse>;
  onClose: () => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const tokens = TOKENS[product.id]!;
  const choices = action === "deposit" ? [tokens.deposit] : tokens.withdraw;
  // withdraw は保有のある address / トークンを既定にする
  const firstHolder = addresses.find((a) => byAddress.get(a)?.holdings.some((h) => h.productId === product.id));
  const [owner, setOwner] = useState(action === "withdraw" && firstHolder ? firstHolder : (addresses[0] ?? ""));
  const heldToken = choices.find((s) => balanceOf(byAddress.get(owner), product, action, s));
  const [token, setToken] = useState(heldToken ?? choices[0]!);
  const [amount, setAmount] = useState("");
  const balance = balanceOf(byAddress.get(owner), product, action, token);

  const request = (): MenuPlanRequest => ({ owner, productId: product.id, action, amount: amount.trim(), ...(choices.length > 1 ? { token } : {}) });
  const plan = useMutation({ mutationFn: () => api.ethMenuPlan(request()) });
  const exec = useMutation({
    mutationFn: () => api.ethMenuExecuteOnFork(request()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["eth", "holdings"] });
      qc.invalidateQueries({ queryKey: ["eth", "events"] });
    },
  });
  const reset = () => {
    plan.reset();
    exec.reset();
  };
  const valid = DECIMAL.test(amount.trim()) && !/^0+(\.0+)?$/.test(amount.trim());

  if (addresses.length === 0) {
    return <p className="muted small">Watch or connect an Ethereum address to {action}.</p>;
  }
  return (
    <div className="menu-action" aria-live="polite">
      <div className="preview-head">
        <p className="overline">{actionLabel(product, action)}</p>
        {plan.data && <TargetBadge plan={plan.data} />}
      </div>
      {!plan.data ? (
        <form
          className="menu-action-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) plan.mutate();
          }}
        >
          {addresses.length > 1 && (
            <label className="small">
              From
              <select className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
                {addresses.map((a) => (
                  <option key={a} value={a}>
                    {shortAddress(a)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="small" htmlFor={id}>
            Amount
          </label>
          <div className="input-row">
            <input id={id} className="input" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
            {choices.length > 1 ? (
              <select className="select" aria-label="Token" value={token} onChange={(e) => setToken(e.target.value)}>
                {choices.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            ) : (
              <span className="muted small unit">{token}</span>
            )}
            <button type="button" className="btn btn-quiet" disabled={!balance || balance.value === "0"} onClick={() => balance && setAmount(toHumanReadable(balance.value, balance.decimals))}>
              Max
            </button>
          </div>
          <p className="muted small">
            {balance ? `Available: ${fmtAmount(balance, 6)} (mainnet)` : byAddress.get(owner) ? `No ${token} at ${shortAddress(owner)}.` : "Checking balance…"}
          </p>
          {plan.isError && (
            <p className="error small" role="alert">
              {plan.error instanceof ApiError ? plan.error.message : "Could not build the plan."}
            </p>
          )}
          <div className="menu-action-buttons">
            <button type="submit" className="btn btn-primary" disabled={!valid || plan.isPending}>
              {plan.isPending ? "Building plan…" : "Build plan"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <PlanView plan={plan.data} exec={exec} />
          {exec.isSuccess && <p className="muted small">Balances above are read from mainnet, so they do not change after a fork run.</p>}
          <div className="menu-action-buttons">
            <button type="button" className="btn" onClick={reset}>
              Edit amount
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
