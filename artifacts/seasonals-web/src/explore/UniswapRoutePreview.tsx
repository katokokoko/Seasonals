/**
 * Uniswap Trading API の route preview (USDC → USDe、Ethena に入る前の資産変換、v3 §3)。
 * quote → (fork 稼働時) Chainlink peg guard を通して fork 上で approve → Permit2 → swap。mainnet には送らない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { formatTokenAmount, isValidTokenAmount, toSmallestUnit } from "@workspace/lib/utils/numeric";
import { api, ApiError } from "../services/api";
import { useEthStatus } from "../services/queries";
import { useActiveAddresses } from "../state/session";
import { requestOpenWallet } from "../timeline/detailStore";
import { fmtUsd } from "../ui/format";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDE = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";

export function UniswapRoutePreview() {
  const swapper = useActiveAddresses().find((a) => a.chain === "ethereum")?.address;
  const [amount, setAmount] = useState("1000");
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const q = useMutation({ mutationFn: (smallest: string) => api.uniswapQuote(swapper!, USDC, USDE, smallest) });
  const qc = useQueryClient();
  const status = useEthStatus();
  const forkReady = status.data?.executionTarget === "fork" && status.data.forkReachable;
  const exec = useMutation({
    mutationFn: () => api.uniswapExecuteOnFork(swapper!, USDC, USDE, q.data!.amountIn),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eth", "events"] }),
  });

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
      <label className="small brand-heading" htmlFor={id} style={brandStyle("uniswap")}>
        <ProtocolBadge id="uniswap" name="Uniswap" size={20} />
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
            {q.data.gasFeeUsd ? ` · gas ≈ ${fmtUsd(q.data.gasFeeUsd)}` : ""}
          </p>
          <p className="muted">
            {q.data.approvalRequired ? "Token approval needed. " : ""}
            {q.data.permitSignatureRequired ? "Permit2 permission needed (a signature in your wallet; the fork demo uses a Permit2 transaction instead). " : ""}
            {q.data.nextStep}
          </p>
          <p className="freshness">Source: Uniswap Trading API · {new Date(q.data.quotedAt).toLocaleTimeString()}</p>
          {forkReady && !exec.isSuccess && (
            <div className="fork-exec">
              <button type="button" className="btn btn-primary" onClick={() => exec.mutate()} disabled={exec.isPending}>
                {exec.isPending ? "Checking price guard and executing on fork…" : "Approve and swap on local fork"}
              </button>
              <span className="muted small">
                Checks the Chainlink USDe/USDC peg first (refuses if stale or off by more than 0.5%), then runs approve → Permit2 → swap as the watched
                address on an Anvil fork. Mainnet is never touched.
              </span>
            </div>
          )}
          {exec.isError && <p className="error small">{exec.error instanceof ApiError ? exec.error.message : "Swap failed."}</p>}
          {exec.isSuccess && (
            <div className="sim sim-ok">
              <strong>
                {exec.data.txs.every((t) => t.status === "success") ? "Swapped on the local fork." : "The swap did not complete on the fork."}
              </strong>{" "}
              Price guard: {exec.data.plan.peg.reason}
              <ul className="plain-list">
                {exec.data.txs.map((t) => (
                  <li key={t.hash} className="mono">
                    {t.status} · {t.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
