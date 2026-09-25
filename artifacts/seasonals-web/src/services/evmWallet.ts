/**
 * Injected EIP-1193 wallet (MetaMask 等) — address の取得のみ。
 * 署名は wallet 側で行い、Seasonals は秘密鍵を扱わない (CLAUDE.md §5)。
 */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}

export function injectedProvider(): Eip1193 | null {
  const w = window as unknown as { ethereum?: Eip1193 };
  return w.ethereum ?? null;
}

export async function connectInjected(): Promise<string> {
  const p = injectedProvider();
  if (!p) throw new Error("No browser wallet detected.");
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error("The wallet returned no account.");
  return first;
}

export function onAccountsChanged(cb: (address: string | null) => void): () => void {
  const p = injectedProvider();
  if (!p?.on) return () => {};
  const h = (...args: unknown[]) => {
    const accounts = args[0] as string[] | undefined;
    cb(accounts?.[0] ?? null);
  };
  p.on("accountsChanged", h);
  return () => p.removeListener?.("accountsChanged", h);
}
