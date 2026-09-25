/**
 * Uniswap Trading API の route preview (USDC → USDe、Ethena に入る前の資産変換、v3 §3)。
 * quote のみ。swap は価格依存の実行なので fail-closed の価格ガード実装まで行わない。
 */
import { useMutation } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { formatTokenAmount, isValidTokenAmount, toSmallestUnit } from "@workspace/lib/utils/numeric";
import { api, ApiError } from "../services/api";
import { useActiveAddresses } from "../state/session";
import { requestOpenWallet } from "../timeline/detailStore";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDE = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";

export function UniswapRoutePreview() {
  const swapper = useActiveAddresses().find((a) => a.chain === "ethereum")?.address;
  const [amount, setAmount] = useState("1000");
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const q = useMutation({ mutationFn: (smallest: string) => api.uniswapQuote(swapper!, USDC, USDE, smallest) });

  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    let smallest: string;
    try {
      smallest = toSmallestUnit(amount.trim(), 6);
    } catch {
      setErr("Enter a USDC amount such as 1000 or 250.5");
      return;
    }
    if (!isValidTokenAmount(smallest) || smallest === "0") {
      setErr("Enter an amount greater than 0.");
      return;
    }
    q.mutate(smallest);
  }

  if (!swapper) {
    return (
      <p className="muted small">
        Route preview needs an Ethereum address.{" "}
        <button type="button" className="btn-link" onClick={requestOpenWallet}>
          Connect wallet
        </button>
      </p>
    );
  }
  return (
    <form className="route-preview" onSubmit={submit}>
      <label className="small" htmlFor={id}>
        Get USDe from USDC first (Uniswap route preview)
      </label>
      <div className="input-row">
        <input id={id} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby={`${id}-unit`} />
        <span id={`${id}-unit`} className="muted small unit">
          USDC
        </span>
        <button type="submit" className="btn" disabled={q.isPending}>
          {q.isPending ? "Quoting…" : "Quote"}
        </button>
      </div>
      {err && <p className="error small">{err}</p>}
      {q.isError && <p className="error small">{q.error instanceof ApiError ? q.error.message : "Quote failed."}</p>}
      {q.data && (
        <div className="small route-result">
          <p>
            ≈{" "}
            <strong>{q.data.amountOut ? `${formatTokenAmount(q.data.amountOut, 18, { maxFractionDigits: 2 })} USDe` : "amount unavailable"}</strong> via{" "}
            {q.data.routing}
            {q.data.gasFeeUsd ? ` · gas ≈ $${Number(q.data.gasFeeUsd).toFixed(2)}` : ""}
          </p>
          <p className="muted">
            {q.data.approvalRequired ? "Token approval needed. " : ""}
            {q.data.permitSignatureRequired ? "Permit2 signature needed. " : ""}
            Quote only — {q.data.nextStep}
          </p>
          <p className="freshness">Source: Uniswap Trading API · {new Date(q.data.quotedAt).toLocaleTimeString()}</p>
        </div>
      )}
    </form>
  );
}
