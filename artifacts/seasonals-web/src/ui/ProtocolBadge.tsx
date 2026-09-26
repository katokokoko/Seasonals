/**
 * Protocol logo + ブランド色。
 * - Solana 系は既存 mobile の brand PNG (artifacts/seasonals/assets/brands) を再利用
 * - Ethereum 系は web の src/assets/brands (公式ロゴを crop / 縮小したもの)
 * 無い protocol は頭文字の monogram (brand 色が分かればその地色、無ければ soda)。
 */
import type { CSSProperties } from "react";
import { PROTOCOL_BRAND, type ProtocolBrandKey } from "@workspace/lib/design-system";

const LOGOS = {
  ...import.meta.glob("../../../seasonals/assets/brands/*.png", { eager: true, query: "?url", import: "default" }),
  ...import.meta.glob("../assets/brands/*.png", { eager: true, query: "?url", import: "default" }),
} as Record<string, string>;

const BY_ID: Record<string, string> = {};
for (const [path, url] of Object.entries(LOGOS)) {
  const id = path.split("/").pop()!.replace(/\.png$/, "");
  BY_ID[id] = url;
}
/** event / menu の protocol id → logo ファイル名 (CCA は Uniswap、Aqua は 1inch の製品) */
const ALIAS: Record<string, string> = {
  save: "savefi",
  "swap-earn": "jupiter",
  cca: "uniswap",
  aqua: "1inch",
};
/**
 * 円いっぱいの意匠ではない (縦長・余白前提の) ロゴ。cover で円に切ると欠けるので
 * contain + 内側余白で白地の円に収める。Ethena / 1inch は円・正方形いっぱいなので cover のまま。
 */
const CONTAIN = new Set(["lido", "pendle", "uniswap"]);
/** logo ファイル名 → PROTOCOL_BRAND の key (識別子にできない名前だけ) */
const BRAND_ALIAS: Record<string, string> = { "1inch": "oneinch" };

function canonical(id: string): string {
  const k = id.toLowerCase();
  return ALIAS[k] ?? k;
}

export function protocolLogo(id: string | null | undefined): string | null {
  if (!id) return null;
  return BY_ID[canonical(id)] ?? null;
}

export function protocolBrandKey(id: string | null | undefined): ProtocolBrandKey | null {
  if (!id) return null;
  const c = canonical(id);
  const k = BRAND_ALIAS[c] ?? c;
  return k in PROTOCOL_BRAND ? (k as ProtocolBrandKey) : null;
}

/**
 * 行 / カードに渡す accent 変数 (`--accent` 線、`--accent-bg` 薄い背景)。
 * brand 色の無い protocol は空 (CSS 側の既定 = 中立表示)。
 */
export function brandStyle(id: string | null | undefined): CSSProperties {
  const k = protocolBrandKey(id);
  if (!k) return {};
  return { "--accent": `var(--brand-${k})`, "--accent-bg": `var(--brandbg-${k})` } as CSSProperties;
}

export function ProtocolBadge({ id, name, size = 28 }: { id: string | null; name: string | null; size?: number }) {
  const url = protocolLogo(id);
  const label = name ?? id ?? "Plan";
  if (url) {
    const contain = CONTAIN.has(canonical(id!));
    return (
      <img
        className={contain ? "protocol-badge contain" : "protocol-badge"}
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    );
  }
  const brand = protocolBrandKey(id);
  return (
    <span
      className="protocol-badge monogram"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        ...(brand ? { background: `var(--brand-${brand})` } : {}),
      }}
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}
