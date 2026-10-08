/**
 * WalletControl — Connect wallet / Watch address (UI v2 §1 右端)。
 * - Ethereum: browser の wallet を EIP-6963 で検出して並べ、選んだ wallet から address を取得
 * - Solana: Wallet Standard で検出 (Phantom / Solflare / Backpack …)。reload 後は前回の wallet に silent connect
 * - Watch: 任意の Solana / Ethereum address を読み取り専用で閲覧 (Ethereum v3 §12 watch-mode)
 * 署名は常に wallet 側。Seasonals は秘密鍵を扱わない (CLAUDE.md §5)
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { chainOfAddress, type ChainId } from "@workspace/lib/config/chains";
import { MAX_WATCH, useActiveAddresses, useSession } from "../state/session";
import {
  connectWallet,
  disconnectWallet,
  isUserRejection,
  onAccountsChanged,
  safeWalletIcon,
  useDetectedWallets,
  type DetectedWallet,
} from "../services/evmWallet";
import {
  connectSolanaWallet,
  disconnectSolanaWallet,
  isSolanaUserRejection,
  onSolanaAccountsChanged,
  useDetectedSolanaWallets,
  type SolanaDetectedWallet,
} from "../services/solanaWallet";
import { ChainIcon } from "../ui/ChainIcon";
import { IconChevronDown, IconClose, IconWallet } from "../ui/icons";
import { shortAddress } from "../ui/format";
import { OPEN_WALLET_EVENT } from "../timeline/detailStore";

export function WalletControl() {
  const { addWatch, removeWatch, setConnected, connected, lastSolanaWallet } = useSession();
  const active = useActiveAddresses();
  const wallets = useDetectedWallets();
  const solWallets = useDetectedSolanaWallets();
  /** silent 再接続は wallet ごとに 1 回だけ試す (prompt を何度も出さない) */
  const silentTried = useRef(new Set<string>());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 接続を待っている wallet (`${chain}:${id}`) */
  const [pending, setPending] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputId = useId();

  useEffect(
    () =>
      onAccountsChanged((a) => {
        // wallet 側で接続を外された (空配列) ら、以後その wallet を聞かない
        if (!a) disconnectWallet();
        setConnected("ethereum", a);
      }),
    [setConnected]
  );
  useEffect(() => onSolanaAccountsChanged((a) => setConnected("solana", a)), [setConnected]);
  // reload 後: 前回接続した Solana wallet が (遅れてでも) 名乗ったら、prompt なしで戻す
  const solConnected = Boolean(connected.solana);
  useEffect(() => {
    if (solConnected || !lastSolanaWallet || silentTried.current.has(lastSolanaWallet)) return;
    const w = solWallets.find((x) => x.name === lastSolanaWallet);
    if (!w) return;
    silentTried.current.add(w.name);
    connectSolanaWallet(w, { silent: true })
      .then((address) => setConnected("solana", address, { name: w.name, icon: w.icon, rdns: w.name }))
      .catch(() => {
        /* 許可が切れていれば何もしない (ユーザーが押せば通常の connect) */
      });
  }, [solConnected, lastSolanaWallet, solWallets, setConnected]);
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

  async function onConnect(w: DetectedWallet) {
    setError(null);
    setPending(`ethereum:${w.info.rdns}`);
    try {
      const address = await connectWallet(w);
      setConnected("ethereum", address, { name: w.info.name, icon: w.info.icon, rdns: w.info.rdns });
    } catch (e) {
      if (isUserRejection(e)) setError(`Request was rejected in ${w.info.name}.`);
      else setError(e instanceof Error ? e.message : "Could not connect.");
    } finally {
      setPending(null);
    }
  }

  async function onConnectSolana(w: SolanaDetectedWallet) {
    setError(null);
    setPending(`solana:${w.name}`);
    try {
      const address = await connectSolanaWallet(w);
      setConnected("solana", address, { name: w.name, icon: w.icon, rdns: w.name });
    } catch (e) {
      if (isSolanaUserRejection(e)) setError(`Request was rejected in ${w.name}.`);
      else setError(e instanceof Error ? e.message : "Could not connect.");
    } finally {
      setPending(null);
    }
  }

  function onDisconnect(chain: ChainId) {
    if (chain === "solana") void disconnectSolanaWallet();
    else disconnectWallet();
    setConnected(chain, null);
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
              {active.map((a) => {
                const via = a.connected ? connected[a.chain]?.wallet : undefined;
                return (
                <li key={`${a.chain}:${a.address}`}>
                  <ChainIcon chain={a.chain} size={16} />
                  <span className="mono">{shortAddress(a.address)}</span>
                  {via ? (
                    <span className="tag wallet-via">
                      <WalletIcon icon={via.icon} size={12} />
                      {via.name}
                    </span>
                  ) : (
                    <span className="tag">{a.connected ? "connected" : "watching"}</span>
                  )}
                  <button
                    type="button"
                    className="icon-button small"
                    aria-label={`Remove ${shortAddress(a.address)}`}
                    onClick={() => (a.connected ? onDisconnect(a.chain) : removeWatch(a))}
                  >
                    <IconClose size={14} />
                  </button>
                </li>
                );
              })}
            </ul>
          )}
          <section>
            <h3 className="popover-title">Browser wallet (Ethereum)</h3>
            {wallets.length > 0 ? (
              <ul className="wallet-choices" aria-label="Detected wallets">
                {wallets.map((w) => {
                  const isConnected = connected.ethereum?.wallet.rdns === w.info.rdns;
                  const waiting = pending === `ethereum:${w.info.rdns}`;
                  return (
                    <li key={w.info.rdns}>
                      <button
                        type="button"
                        className={`wallet-choice${isConnected ? " is-connected" : ""}`}
                        onClick={() => onConnect(w)}
                        disabled={pending !== null}
                        aria-busy={waiting || undefined}
                      >
                        <WalletIcon icon={w.info.icon} size={20} />
                        <span className="wallet-choice-name">{w.info.name}</span>
                        {isConnected && <span className="tag">connected</span>}
                        <span className="wallet-choice-action">
                          {waiting ? "Waiting…" : isConnected ? "Reconnect" : "Connect"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted small">No browser wallet detected. You can still watch an address below.</p>
            )}
          </section>
          <section>
            <h3 className="popover-title">Browser wallet (Solana)</h3>
            {solWallets.length > 0 ? (
              <ul className="wallet-choices" aria-label="Detected Solana wallets">
                {solWallets.map((w) => {
                  const isConnected = connected.solana?.wallet.rdns === w.name;
                  const waiting = pending === `solana:${w.name}`;
                  return (
                    <li key={w.name}>
                      <button
                        type="button"
                        className={`wallet-choice${isConnected ? " is-connected" : ""}`}
                        onClick={() => onConnectSolana(w)}
                        disabled={pending !== null}
                        aria-busy={waiting || undefined}
                      >
                        <WalletIcon icon={w.icon} size={20} />
                        <span className="wallet-choice-name">{w.name}</span>
                        {isConnected && <span className="tag">connected</span>}
                        <span className="wallet-choice-action">
                          {waiting ? "Waiting…" : isConnected ? "Reconnect" : "Connect"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted small">No Solana wallet detected (Phantom, Solflare, Backpack …).</p>
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

/** wallet が名乗った icon (data:image/ のみ)。無い / 不正なら汎用の wallet icon */
function WalletIcon({ icon, size }: { icon: string; size: number }) {
  const src = safeWalletIcon(icon);
  if (!src) return <IconWallet size={size} className="wallet-icon is-generic" aria-hidden="true" />;
  return <img className="wallet-icon" src={src} alt="" width={size} height={size} />;
}
