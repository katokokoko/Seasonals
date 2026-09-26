/**
 * Menu カード内の deposit / withdraw パネル。
 * 数量 → BFF /eth/menu/plan (未署名プラン、mainnet に eth_call) → PlanView → 承認で fork 実行。
 * 金額は decimal string のまま BFF へ渡し、smallest unit への変換と残高検証は BFF が on-chain で行う。
 * Max は BFF が返した残高 (smallest unit) を toHumanReadable で正確に戻したもの (Number を通さない)。
 */
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toHumanReadable } from "@workspace/lib/utils/numeric";
import type { MenuHoldingsResponse, MenuProduct, TokenAmountView } from "@workspace/lib/types";
import { api, ApiError, type MenuPlanRequest } from "../services/api";
import { PlanView, TargetBadge } from "../timeline/PlanView";
import { UniswapRoutePreview } from "./UniswapRoutePreview";
import { fmtAmount, shortAddress } from "../ui/format";

export type MenuAction = "deposit" | "withdraw";

/** 商品ごとに、入金に使うトークンと引き出せるトークン */
const TOKENS: Record<string, { deposit: string; withdraw: string[] }> = {
  "ethereum:lido:steth": { deposit: "ETH", withdraw: ["stETH", "wstETH"] },
  "ethereum:ethena:susde": { deposit: "USDe", withdraw: ["sUSDe"] },
};

/** Menu から deposit / withdraw できる商品か (Pendle PT / YT は BFF の価格 guard 付き) */
export function menuActionable(product: MenuProduct): boolean {
  return product.id in TOKENS || Boolean(product.tokenKind);
}

/**
 * ボタンと見出しは全商品で Deposit / Withdraw に統一する。
 * 中身の違い (Lido の stake / 出金申請、Ethena の cooldown、Pendle の売買) はプランの summary と注意書きで示す
 */
export function actionLabel(action: MenuAction): string {
  return action === "deposit" ? "Deposit" : "Withdraw";
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
  const pendle = Boolean(product.tokenKind);
  // withdraw は保有のある address / トークンを既定にする
  const firstHolder = addresses.find((a) => byAddress.get(a)?.holdings.some((h) => h.productId === product.id));
  const [owner, setOwner] = useState(action === "withdraw" && firstHolder ? firstHolder : (addresses[0] ?? ""));
  // Pendle: 払う / 受け取るトークンは market ごとに違うので BFF が on-chain で読んだ文脈を使う
  const ctx = useQuery({
    queryKey: ["eth", "menu-context", owner.toLowerCase(), product.id, action],
    queryFn: () => api.ethMenuContext(owner, product.id, action),
    enabled: pendle && Boolean(owner),
    staleTime: 30_000,
    retry: 1,
  });
  const tokens = TOKENS[product.id];
  const pendleUnit = ctx.data ? (action === "deposit" ? ctx.data.token : ctx.data.pyToken) : undefined;
  const choices = tokens ? (action === "deposit" ? [tokens.deposit] : tokens.withdraw) : [pendleUnit?.symbol ?? "…"];
  const heldToken = choices.find((s) => balanceOf(byAddress.get(owner), product, action, s));
  const [picked, setToken] = useState(heldToken ?? choices[0]!);
  const token = choices.includes(picked) ? picked : choices[0]!;
  const [amount, setAmount] = useState("");
  // Ethena の Deposit だけ: USDC しか無い人向けに、先に Uniswap で USDe に換える経路をパネル内に出す
  const needsUsde = product.id === "ethereum:ethena:susde" && action === "deposit";
  const [routeOpen, setRouteOpen] = useState(false);
  // fork 上で swap した USDe は fork にしか無いので、続きの Deposit は fork の状態で確かめる
  const [forkState, setForkState] = useState(false);
  const balance = pendle ? pendleUnit : balanceOf(byAddress.get(owner), product, action, token);
  // 取引できない理由 (Pendle): 満期済み / オラクル未準備。BFF でも同じ理由で拒否される (fail-closed)
  const blocked = ctx.data?.matured
    ? action === "deposit"
      ? "This market has matured; it can no longer be bought."
      : product.tokenKind === "pt"
        ? "This PT has matured. Redeem it 1:1 from its calendar event."
        : "This YT has matured and is worth 0."
    : ctx.data && !ctx.data.oracleReady
      ? "Pendle's on-chain price oracle is not ready for this market, so trading it is blocked (prices cannot be checked)."
      : null;

  const request = (): MenuPlanRequest => ({ owner, productId: product.id, action, amount: amount.trim(), ...(tokens && choices.length > 1 ? { token } : {}) });
  const plan = useMutation({ mutationFn: () => api.ethMenuPlan({ ...request(), ...(forkState ? { state: "fork" as const } : {}) }) });
  const exec = useMutation({
    mutationFn: () => api.ethMenuExecuteOnFork(request()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["eth", "holdings"] });
      qc.invalidateQueries({ queryKey: ["eth", "events"] });
      qc.invalidateQueries({ queryKey: ["eth", "menu-context"] });
    },
  });
  const reset = () => {
    plan.reset();
    exec.reset();
  };
  const valid = DECIMAL.test(amount.trim()) && !/^0+(\.0+)?$/.test(amount.trim()) && !blocked && (!pendle || Boolean(ctx.data));

  if (addresses.length === 0) {
    return <p className="muted small">Watch or connect an Ethereum address to {action}.</p>;
  }
  return (
    <div className="menu-action" aria-live="polite">
      <div className="preview-head">
        <p className="overline">{actionLabel(action)}</p>
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
            {balance
              ? `Available: ${fmtAmount(balance, 6)} (mainnet)`
              : (pendle ? ctx.isSuccess : byAddress.get(owner))
                ? `No ${token} at ${shortAddress(owner)}.`
                : "Checking balance…"}
          </p>
          {blocked && (
            <p className="menu-warning small" role="alert">
              {blocked}
            </p>
          )}
          {ctx.isError && (
            <p className="error small" role="alert">
              {ctx.error instanceof ApiError ? ctx.error.message : "Could not read this market."}
            </p>
          )}
          {plan.isError && (
            <p className="error small" role="alert">
              {plan.error instanceof ApiError ? plan.error.message : "Could not build the plan."}
            </p>
          )}
          {forkState && (
            <p className="muted small">
              The swapped USDe exists only on the local fork, so this deposit is checked against the fork state instead of mainnet.
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
      ) : null}
      {!plan.data && needsUsde && (
        <div className="menu-route">
          {routeOpen ? (
            <UniswapRoutePreview swapper={owner} onSwapped={() => setForkState(true)} />
          ) : (
            <button type="button" className="btn-link small" onClick={() => setRouteOpen(true)}>
              Only have USDC? Swap it to USDe on Uniswap first
            </button>
          )}
        </div>
      )}
      {!plan.data ? null : (
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
