/**
 * Protocol logo — 既存 mobile の brand PNG (artifacts/seasonals/assets/brands) を再利用。
 * 無い protocol は頭文字の monogram (token 色)。
 */
const LOGOS = import.meta.glob("../../../seasonals/assets/brands/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const BY_ID: Record<string, string> = {};
for (const [path, url] of Object.entries(LOGOS)) {
  const id = path.split("/").pop()!.replace(/\.png$/, "");
  BY_ID[id] = url;
}
const ALIAS: Record<string, string> = { save: "savefi", "jupiter-lend": "jupiter-lend", "swap-earn": "jupiter" };

export function protocolLogo(id: string | null | undefined): string | null {
  if (!id) return null;
  const k = id.toLowerCase();
  return BY_ID[ALIAS[k] ?? k] ?? null;
}

export function ProtocolBadge({ id, name, size = 28 }: { id: string | null; name: string | null; size?: number }) {
  const url = protocolLogo(id);
  const label = name ?? id ?? "Plan";
  if (url) {
    return <img className="protocol-badge" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  }
  return (
    <span className="protocol-badge monogram" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {label.charAt(0).toUpperCase()}
    </span>
  );
}
