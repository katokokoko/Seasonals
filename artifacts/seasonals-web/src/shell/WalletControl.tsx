/**
 * WalletControl — Connect wallet / Watch address (UI v2 §1 右端)。
 * - Ethereum: injected wallet (EIP-1193) で address を取得。署名は wallet 側
 * - Watch: 任意の Solana / Ethereum address を読み取り専用で閲覧 (Ethereum v3 §12 watch-mode)
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { chainOfAddress } from "@workspace/lib/config/chains";
import { activeAddresses, useSession } from "../state/session";
import { connectInjected, injectedProvider, onAccountsChanged } from "../services/evmWallet";
import { ChainIcon } from "../ui/ChainIcon";
import { IconChevronDown, IconClose, IconWallet } from "../ui/icons";
import { shortAddress } from "../ui/format";
import { OPEN_WALLET_EVENT } from "../timeline/detailStore";

export function WalletControl() {
  const { watch, connectedEvm, setWatch, setConnectedEvm } = useSession();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const addrs = activeAddresses({ watch, connectedEvm });
  const entries = Object.entries(addrs) as Array<["solana" | "ethereum", string]>;

  useEffect(() => onAccountsChanged((a) => setConnectedEvm(a)), [setConnectedEvm]);
  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      window.setTimeout(() => ref.current?.querySelector<HTMLElement>("input, .btn-primary")?.focus(), 0);
    };
    window.addEventListener(OPEN_WALLET_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WALLET_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function onConnect() {
    setError(null);
    setBusy(true);
    try {
      setConnectedEvm(await connectInjected());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect.");
    } finally {
      setBusy(false);
    }
  }

  function onWatch(e: FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    const chain = chainOfAddress(v);
    if (!chain) {
      setError("Enter a Solana or Ethereum (0x…) address.");
      return;
    }
    setWatch(chain, v);
    setDraft("");
    setError(null);
  }

  const first = entries[0];
  return (
    <div className="wallet" ref={ref}>
      <button
        type="button"
        className={`wallet-button${first ? " is-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {first ? (
          <>
            <ChainIcon chain={first[0]} size={16} />
            <span className="mono">{shortAddress(first[1])}</span>
            {first[0] === "ethereum" && connectedEvm ? null : <span className="tag">watching</span>}
            {entries.length > 1 && <span className="tag">+{entries.length - 1}</span>}
            <IconChevronDown size={14} />
          </>
        ) : (
          <>
            <IconWallet size={18} />
            Connect wallet
          </>
        )}
      </button>
      {open && (
        <div className="popover wallet-popover" role="dialog" aria-label="Wallet">
          {entries.length > 0 && (
            <ul className="wallet-list">
              {entries.map(([chain, a]) => (
                <li key={chain}>
                  <ChainIcon chain={chain} size={16} />
                  <span className="mono">{shortAddress(a)}</span>
                  <span className="tag">{chain === "ethereum" && connectedEvm === a ? "connected" : "watching"}</span>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Disconnect ${chain} address`}
                    onClick={() => (chain === "ethereum" && connectedEvm === a ? setConnectedEvm(null) : setWatch(chain, null))}
                  >
                    <IconClose size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <section>
            <h3 className="popover-title">Browser wallet (Ethereum)</h3>
            {injectedProvider() ? (
              <button type="button" className="btn btn-primary" onClick={onConnect} disabled={busy}>
                {connectedEvm ? "Reconnect" : "Connect browser wallet"}
              </button>
            ) : (
              <p className="muted small">No browser wallet detected. You can still watch an address below.</p>
            )}
            <p className="muted small">Seasonals never holds keys. Signing always happens in your wallet.</p>
          </section>
          <form onSubmit={onWatch}>
            <label className="popover-title" htmlFor={inputId}>
              Watch an address (read-only)
            </label>
            <div className="input-row">
              <input
                id={inputId}
                className="input mono"
                placeholder="0x… or Solana address"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className="btn">
                Watch
              </button>
            </div>
          </form>
          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
