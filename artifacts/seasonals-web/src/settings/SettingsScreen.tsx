/**
 * SettingsScreen — /settings (UI v2 §11)。閲覧 address、対応 chain、表示設定、
 * server 側 integration の設定有無 (値は返さない) を確認する。
 */
import { useEffect, useState } from "react";
import { SUPPORTED_CHAINS } from "@workspace/lib/config/chains";
import { useActiveAddresses } from "../state/session";
import { useEthStatus } from "../services/queries";
import { WorkspaceShell, Notice } from "../shell/WorkspaceShell";
import { requestOpenWallet } from "../timeline/detailStore";
import { ChainIcon } from "../ui/ChainIcon";
import { shortAddress } from "../ui/format";
import "../agent/agent.css";

export default function SettingsScreen() {
  const active = useActiveAddresses();
  const status = useEthStatus();
  const reduced = useReducedMotion();

  return (
    <WorkspaceShell title="Settings" subtitle="Make it yours">
      <div className="agent-grid">
        <section className="panel-block">
          <h2>Wallets</h2>
          {active.length === 0 ? (
            <p className="muted">No wallet connected or watched.</p>
          ) : (
            <ul className="settings-list">
              {active.map((a) => (
                <li key={`${a.chain}:${a.address}`}>
                  <ChainIcon chain={a.chain} size={16} />
                  <span className="mono">{shortAddress(a.address)}</span>
                  <span className="tag">{a.connected ? "connected" : "watching"}</span>
                </li>
              ))}
            </ul>
          )}
          <div>
            <button type="button" className="btn" onClick={requestOpenWallet}>
              Manage wallets
            </button>
          </div>
        </section>
        <section className="panel-block">
          <h2>Supported chains</h2>
          <ul className="settings-list">
            {SUPPORTED_CHAINS.map((c) => (
              <li key={c.id}>
                <ChainIcon chain={c.id} size={16} /> {c.name} <span className="muted small mono">{c.caip2}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">Ethereum reads mainnet. Transaction demos run only on a local mainnet fork.</p>
        </section>
        <section className="panel-block">
          <h2>Motion</h2>
          <p className="muted">
            {reduced
              ? "Your system asks for reduced motion. The water background is a still image and transitions are off."
              : "The water background animates slowly. Turn on “Reduce motion” in your system settings for a still background."}
          </p>
        </section>
        <section className="panel-block">
          <h2>Server integrations</h2>
          {status.isError ? (
            <Notice tone="warning" title="Ethereum integration is not available on this server yet." />
          ) : status.isPending ? (
            <p className="muted">Checking…</p>
          ) : (
            <ul className="settings-list">
              <li>Ethereum RPC: {status.data.rpcConfigured ? "configured" : "not configured"}</li>
              <li>Uniswap Trading API: {status.data.uniswapConfigured ? "configured" : "not configured"}</li>
              <li>Execution target: {status.data.executionTarget === "fork" ? `local fork (${status.data.forkReachable ? "reachable" : "not running"})` : "mainnet (plans only)"}</li>
              <li>Proposals: {status.data.llmConfigured ? "LLM" : "rule-based"}</li>
            </ul>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}

function useReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!m) return;
    const on = () => setR(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return Boolean(r);
}
