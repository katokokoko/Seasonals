/**
 * WalletControl — Connect wallet / Watch address (UI v2 §1 右端)。
 * - Ethereum: injected wallet (EIP-1193) で address を取得。署名は wallet 側
 * - Watch: 任意の Solana / Ethereum address を読み取り専用で閲覧 (Ethereum v3 §12 watch-mode)
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { chainOfAddress } from "@workspace/lib/config/chains";
import { MAX_WATCH, useActiveAddresses, useSession } from "../state/session";
import { connectInjected, injectedProvider, onAccountsChanged } from "../services/evmWallet";
import { ChainIcon } from "../ui/ChainIcon";
import { IconChevronDown, IconClose, IconWallet } from "../ui/icons";
import { shortAddress } from "../ui/format";
import { OPEN_WALLET_EVENT } from "../timeline/detailStore";

export function WalletControl() {
  const { addWatch, removeWatch, setConnectedEvm } = useSession();
  const active = useActiveAddresses();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputId = useId();

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
    addWatch({ chain, address: v });
    setDraft("");
    setError(null);
  }

  const first = active[0];
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
            <ChainIcon chain={first.chain} size={16} />
            <span className="mono">{shortAddress(first.address)}</span>
            {!first.connected && <span className="tag">watching</span>}
            {active.length > 1 && <span className="tag">+{active.length - 1}</span>}
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
          {active.length > 0 && (
            <ul className="wallet-list">
              {active.map((a) => (
                <li key={`${a.chain}:${a.address}`}>
                  <ChainIcon chain={a.chain} size={16} />
                  <span className="mono">{shortAddress(a.address)}</span>
                  <span className="tag">{a.connected ? "connected" : "watching"}</span>
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Remove ${shortAddress(a.address)}`}
                    onClick={() => (a.connected ? setConnectedEvm(null) : removeWatch(a))}
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
                {active.some((a) => a.connected) ? "Reconnect" : "Connect browser wallet"}
              </button>
            ) : (
              <p className="muted small">No browser wallet detected. You can still watch an address below.</p>
            )}
            <p className="muted small">Seasonals never holds keys. Signing always happens in your wallet.</p>
          </section>
          <form onSubmit={onWatch}>
            <label className="popover-title" htmlFor={inputId}>
              Watch an address (read-only, up to {MAX_WATCH})
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
