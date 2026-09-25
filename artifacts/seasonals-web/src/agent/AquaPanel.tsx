/**
 * AquaPanel — LP sleeve (Ethereum v3 §3 Aqua / §7 guardrails)。
 * Agent / 人が選べるのは template (PEGGED_STABLE) と parameter だけ。アプリが検証し、
 * Chainlink USDe/USDC の peg guard (fail-closed) を通った時だけ plan を返す。
 * 実行 (ship / fill) は Anvil fork のみ。ship 後は review 日に「strategy review」が calendar に載り、そこから dock する。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { formatTokenAmount, toSmallestUnit } from "@workspace/lib/utils/numeric";
import { api, ApiError, type AquaShipInput } from "../services/api";
import { useEthStatus } from "../services/queries";
import { useActiveAddresses } from "../state/session";
import { requestOpenWallet } from "../timeline/detailStore";
import { shortAddress } from "../ui/format";

const inTwoWeeks = () => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

export function AquaPanel() {
  const maker = useActiveAddresses().find((a) => a.chain === "ethereum")?.address;
  const status = useEthStatus();
  const forkReady = status.data?.executionTarget === "fork" && status.data.forkReachable;
  const qc = useQueryClient();
  const id = useId();
  const [usdc, setUsdc] = useState("40");
  const [usde, setUsde] = useState("40");
  const [band, setBand] = useState(50);
  const [review, setReview] = useState(inTwoWeeks);
  const [taker, setTaker] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const input = (): AquaShipInput | null => {
    try {
      return {
        maker: maker!,
        template: "PEGGED_STABLE",
        usdcAmount: toSmallestUnit(usdc.trim(), 6),
        usdeAmount: toSmallestUnit(usde.trim(), 18),
        bandBps: band,
        reviewAt: new Date(`${review}T00:00:00`).toISOString(),
      };
    } catch {
      return null;
    }
  };
  const plan = useMutation({ mutationFn: (i: AquaShipInput) => api.aquaShipPlan(i) });
  const ship = useMutation({
    mutationFn: (i: AquaShipInput) => api.aquaShipOnFork(i),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eth", "events"] }),
  });
  const fill = useMutation({ mutationFn: () => api.aquaFillOnFork(ship.data!.plan.strategyHash, taker.trim(), toSmallestUnit("10", 6)) });

  function submit(e: FormEvent, mode: "plan" | "ship") {
    e.preventDefault();
    setErr(null);
    const i = input();
    if (!i) {
      setErr("Enter amounts such as 40 or 12.5.");
      return;
    }
    if (mode === "plan") plan.mutate(i);
    else ship.mutate(i);
  }

  if (!maker) {
    return (
      <p className="muted small">
        Needs an Ethereum address as the maker.{" "}
        <button type="button" className="btn-link" onClick={requestOpenWallet}>
          Connect wallet
        </button>
      </p>
    );
  }
  return (
    <div className="aqua-panel">
      <form className="aqua-form" onSubmit={(e) => submit(e, "plan")}>
        <label>
          <span className="small">USDC</span>
          <input className="input" inputMode="decimal" value={usdc} onChange={(e) => setUsdc(e.target.value)} />
        </label>
        <label>
          <span className="small">USDe</span>
          <input className="input" inputMode="decimal" value={usde} onChange={(e) => setUsde(e.target.value)} />
        </label>
        <label>
          <span className="small">Peg band</span>
          <select className="select" value={band} onChange={(e) => setBand(Number(e.target.value))}>
            <option value={25}>±0.25%</option>
            <option value={50}>±0.50%</option>
            <option value={100}>±1.00%</option>
          </select>
        </label>
        <label>
          <span className="small">Review on</span>
          <input className="input" type="date" value={review} onChange={(e) => setReview(e.target.value)} />
        </label>
        <div className="aqua-buttons">
          <button type="submit" className="btn" disabled={plan.isPending}>
            {plan.isPending ? "Checking…" : "Prepare plan (mainnet state)"}
          </button>
          {forkReady && (
            <button type="button" className="btn btn-primary" onClick={(e) => submit(e as unknown as FormEvent, "ship")} disabled={ship.isPending}>
              {ship.isPending ? "Shipping on fork…" : "Approve and ship on local fork"}
            </button>
          )}
        </div>
      </form>
      <p className="muted small">
        Template: PEGGED_STABLE (USDC/USDe) built from existing SwapVM opcodes. Maker {shortAddress(maker)}. Refused automatically if the Chainlink
        USDe/USDC peg is stale or off by more than 0.5%.
      </p>
      {err && <p className="error small">{err}</p>}
      {plan.isError && (
        <p className="error small">On mainnet state: {plan.error instanceof ApiError ? plan.error.message : "Plan failed."}</p>
      )}
      {plan.data && (
        <div className="sim sim-ok small">
          Price guard: {plan.data.peg.reason} · {plan.data.steps.length} step(s), unsigned. Nothing was sent.
        </div>
      )}
      {ship.isError && <p className="error small">{ship.error instanceof ApiError ? ship.error.message : "Ship failed."}</p>}
      {ship.data && !ship.data.txs.every((t) => t.status === "success") && (
        <div className="sim sim-fail small" role="alert">
          <strong>The ship transaction reverted on the fork.</strong> Nothing was shipped. ({ship.data.txs.map((t) => `${t.status}: ${t.description}`).join(" · ")})
        </div>
      )}
      {ship.data && ship.data.txs.every((t) => t.status === "success") && (
        <div className="sim sim-ok small">
          <strong>Shipped on the local fork.</strong> A strategy review is now on your calendar for {review}. Strategy {ship.data.plan.strategyHash.slice(0, 12)}…
          <div className="fill-row">
            <label htmlFor={id} className="small">
              Show one fill: taker address that holds USDC on the fork
            </label>
            <div className="input-row">
              <input id={id} className="input mono" placeholder="0x…" value={taker} onChange={(e) => setTaker(e.target.value)} />
              <button type="button" className="btn" disabled={fill.isPending || !/^0x[0-9a-fA-F]{40}$/.test(taker.trim())} onClick={() => fill.mutate()}>
                {fill.isPending ? "Filling…" : "Fill 10 USDC"}
              </button>
            </div>
            {fill.isError && <p className="error small">{fill.error instanceof ApiError ? fill.error.message : "Fill failed."}</p>}
            {fill.data &&
              (fill.data.txs.every((t) => t.status === "success") ? (
                <p className="small">
                  Filled on fork: 10 USDC → {formatTokenAmount(fill.data.usdeOut, 18, { maxFractionDigits: 4 })} USDe.
                </p>
              ) : (
                <p className="error small" role="alert">
                  The fill reverted on the fork ({fill.data.txs.map((t) => t.status).join(", ")}).
                </p>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
