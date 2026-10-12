/**
 * DS token → CSS custom properties。
 *
 * CSS ファイルでは hex を直書きせず `var(--c-sodaText)` 等で参照する (CLAUDE.md §6)。
 * 値の source of truth は lib/design-system.ts のみ。起動時に 1 回 <style> として注入する。
 */
import {
  COLOR,
  FONT_SIZE,
  FONT_WEB,
  PROTOCOL_BRAND,
  RADIUS,
  SHADOW_WEB,
  SPACE,
  SURFACE_WEB,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import type { TimelineDisplayStatus } from "@workspace/lib/types";

/** UI v2 §7 status → token (色 + 非色 cue の色部分) */
export const STATUS_COLOR: Record<TimelineDisplayStatus, string> = {
  upcoming: COLOR.sodaText,
  planned: COLOR.caramelDark,
  completed: COLOR.melonText,
  warning: COLOR.caramelDark,
  failed: COLOR.cherryDark,
};

export function buildTokenCss(): string {
  const lines: string[] = [];
  const put = (prefix: string, obj: Record<string, string | number>, unit = "") => {
    for (const [k, v] of Object.entries(obj)) lines.push(`--${prefix}-${k}: ${v}${typeof v === "number" ? unit : ""};`);
  };
  put("c", COLOR);
  put("s", SURFACE_WEB);
  put("sh", SHADOW_WEB);
  put("f", FONT_WEB);
  put("fs", FONT_SIZE, "px");
  put("sp", SPACE, "px");
  put("r", RADIUS, "px");
  put("w", WEIGHT);
  put("st", STATUS_COLOR);
  // protocol ブランド色 (装飾のみ、文字色に使わない) と薄い背景
  put("brand", PROTOCOL_BRAND);
  put(
    "brandbg",
    Object.fromEntries(Object.entries(PROTOCOL_BRAND).map(([k, v]) => [k, withAlpha(v, 0.1)]))
  );
  // status の薄い背景 (pill)
  put(
    "stbg",
    Object.fromEntries(Object.entries(STATUS_COLOR).map(([k, v]) => [k, withAlpha(v, 0.12)]))
  );
  // focus ring / 選択色
  lines.push(`--focus-ring: 0 0 0 3px ${withAlpha(COLOR.sodaText, 0.45)};`);
  lines.push(`--c-sodaTextSoft: ${withAlpha(COLOR.sodaText, 0.12)};`);
  lines.push(`--c-melonTextSoft: ${withAlpha(COLOR.melonText, 0.12)};`);
  lines.push(`--c-caramelSoft: ${withAlpha(COLOR.caramel, 0.16)};`);
  lines.push(`--c-cherrySoft: ${withAlpha(COLOR.cherryDark, 0.1)};`);
  return `:root{${lines.join("")}}`;
}

export function injectTokens(doc: Document = document): void {
  if (doc.getElementById("ds-tokens")) return;
  const style = doc.createElement("style");
  style.id = "ds-tokens";
  style.textContent = buildTokenCss();
  doc.head.prepend(style);
}
