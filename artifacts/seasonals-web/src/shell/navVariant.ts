/**
 * navVariant — top bar の glass の種類を URL で切り替える (見た目の比較用)。
 * `?nav=droplet` で水の blob (droplet glass、Home の portal card と同じ)、`?nav=clear` で既定の clear glass。
 * nav の link は query を付けないので、tab の間は sessionStorage に残して遷移しても保つ。
 * storage が使えない環境 (private window 等) では URL の指定だけが効く。
 */
export type NavVariant = "clear" | "droplet";

export const NAV_VARIANT_KEY = "seasonals-nav-variant";

function parse(value: string | null | undefined): NavVariant | null {
  return value === "droplet" || value === "clear" ? value : null;
}

export function resolveNavVariant(search: string, storage: Pick<Storage, "getItem" | "setItem"> | null): NavVariant {
  const fromUrl = parse(new URLSearchParams(search).get("nav"));
  if (fromUrl) {
    try {
      storage?.setItem(NAV_VARIANT_KEY, fromUrl);
    } catch {
      // storage 不可: URL の指定だけ効かせる
    }
    return fromUrl;
  }
  try {
    return parse(storage?.getItem(NAV_VARIANT_KEY)) ?? "clear";
  } catch {
    return "clear";
  }
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function currentNavVariant(): NavVariant {
  return resolveNavVariant(typeof window !== "undefined" ? window.location.search : "", sessionStorageOrNull());
}
