/**
 * Seasonals Design System tokens — TypeScript canonical source
 *
 * `docs/design-system.jsx` の DS object を TypeScript module として export。
 * Mobile / Web / 将来の BFF dashboard 等、すべての UI artifact から:
 *
 *   import { DS, type DSColorToken } from "@workspace/lib/design-system";
 *
 * の形で参照する。hex 直書きを禁止する CLAUDE.md §6 の規約はこの module を
 * 経由することで強制される。
 *
 * 値の variation:
 * - `docs/design-system.jsx` (人間向け visual showcase の React component)
 * - `docs/design-system.md` (human-readable token reference)
 * - `lib/design-system.ts` (★ コードからの canonical source)
 *
 * これら 3 ファイルの token 値は常に同期させる。改修時は 3 つすべて更新する。
 *
 * @see docs/design-system.md (human-readable reference)
 * @see CLAUDE.md §6 (デザインシステム規約)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Color tokens
// ─────────────────────────────────────────────────────────────────────────────

export const COLOR = {
  // Backgrounds
  bgPrimary: "#FFF8E7", // Vanilla — メインページ背景
  bgSecondary: "#F5F0E0", // Deeper vanilla
  bgCard: "rgba(255, 255, 255, 0.35)",
  bgCardHover: "rgba(255, 255, 255, 0.55)",
  bgOverlay: "rgba(224, 247, 250, 0.25)",

  // Brand — Soda Blue (6 steps)
  sodaLight: "#E0F7FA",
  sodaMid: "#B2EBF2",
  sodaDeep: "#80DEEA",
  sodaVivid: "#4DD0E1",
  sodaBold: "#26C6DA",
  sodaText: "#00ACC1", // primary heading / key value

  // Brand — Melon Green (5 steps)
  melonLight: "#A8E6CF",
  melonMid: "#7BD4A8",
  melonDeep: "#56C596",
  melonVivid: "#43A877",
  melonText: "#2E9968", // growth / APY / earnings

  // Accent
  caramel: "#C4956A",
  caramelDark: "#A67B5B",
  cherry: "#E57373",
  cherryDark: "#D32F2F", // urgent alert
  straw: "#FFD54F",
  strawDark: "#FFC107",

  // Text
  textPrimary: "#3E2723",
  textSubtitle: "#5D4E47",
  textMuted: "#8D7E76",
  textOnColor: "#FFFFFF",

  // UI Elements
  border: "rgba(141, 126, 118, 0.12)",
  borderStrong: "rgba(141, 126, 118, 0.25)",
  divider: "rgba(141, 126, 118, 0.08)",
  shadow: "rgba(62, 39, 35, 0.06)",
  shadowStrong: "rgba(62, 39, 35, 0.12)",

  // Semantic (alias for clarity in feature code)
  success: "#2E9968", // = melonText
  warning: "#C4956A", // = caramel
  error: "#D32F2F", // = cherryDark
  info: "#00ACC1", // = sodaText
} as const;

export type DSColorToken = keyof typeof COLOR;

// ─────────────────────────────────────────────────────────────────────────────
// Typography
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Font family names — `expo-font` で `@expo-google-fonts/*` から load される
 * 名前 (suffix `_<weight><Style>` 付き) と一致させる。
 * Mobile 側 `app/_layout.tsx` の useFonts() で実 file 登録される。
 *
 * - Pacifico: brand wordmark のみ (heading / body 禁止)
 * - Quicksand: heading / body / UI 全般
 *   - 400: regular、500: medium、600: semibold、700: bold
 *   - StyleSheet 上で fontWeight を指定しても TextRendering は Family 名で決まるため、
 *     コンポーネント側は fontWeight に合わせて fontFamily も切り替える必要がある時がある
 *     (現状は Quicksand_400Regular を base に fontWeight で OS 側に bold 化させる)
 */
export const FONT = {
  script: "Pacifico_400Regular",
  heading: "Quicksand_700Bold",
  body: "Quicksand_400Regular",
  /** code / hex / data — system mono に fallback */
  mono: "JetBrains Mono",
} as const;

export type DSFontFamily = keyof typeof FONT;

export const FONT_SIZE = {
  displayXL: 56, // hero logo (Pacifico)
  displayLG: 44, // page logo
  displayMD: 32, // section title
  displaySM: 24, // card title
  headingLG: 20, // subsection
  headingMD: 17, // subheading
  headingSM: 14, // label heading
  bodyLG: 16, // lead paragraph
  bodyMD: 14, // default body
  bodySM: 13, // secondary body
  caption: 11, // caption / metadata
  overline: 10, // uppercase section label
  micro: 9, // hex code / smallest
} as const;

export type DSFontSize = keyof typeof FONT_SIZE;

/**
 * Font weight as string literal — React Native TextStyle.fontWeight 互換。
 * (RN は "100"〜"900" の string literal を受け付ける)
 */
export const WEIGHT = {
  bold: "700",
  semibold: "600",
  medium: "500",
  regular: "400",
  light: "300",
} as const;

export type DSWeight = keyof typeof WEIGHT;
export type DSWeightValue = (typeof WEIGHT)[DSWeight];

// ─────────────────────────────────────────────────────────────────────────────
// Spacing
// ─────────────────────────────────────────────────────────────────────────────

export const SPACE = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export type DSSpace = keyof typeof SPACE;

// ─────────────────────────────────────────────────────────────────────────────
// Border radius
// ─────────────────────────────────────────────────────────────────────────────

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 100,
} as const;

export type DSRadius = keyof typeof RADIUS;

// ─────────────────────────────────────────────────────────────────────────────
// Glassmorphism
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 標準 glassmorphism token。
 *
 * NOTE: `backdropFilter` は React Native ではネイティブサポートされない。
 * Mobile (RN) では `expo-blur` の `BlurView` で代替し、本 token は
 * Web 専用として使うこと。RN 用の equivalent は `GLASS_RN` を参照。
 */
export const GLASS = {
  background: "rgba(255, 255, 255, 0.35)",
  backdropFilter: "blur(16px)",
  webkitBackdropFilter: "blur(16px)",
  border: "1px solid rgba(255, 255, 255, 0.5)",
  shadow: "0 4px 24px rgba(62, 39, 35, 0.04)",
} as const;

/**
 * React Native 用の glassmorphism 構成パラメータ。
 * 実装側で `<BlurView intensity={GLASS_RN.blurIntensity} tint={GLASS_RN.blurTint}>`
 * のように使う。
 */
export const GLASS_RN = {
  /** expo-blur BlurView intensity (0-100) */
  blurIntensity: 50,
  /** expo-blur BlurView tint */
  blurTint: "light" as const,
  /** BlurView の上に重ねる背景色 (透過込み) */
  background: "rgba(255, 255, 255, 0.35)",
  /** border color (RN は 1 つの string で borderColor + borderWidth に分ける) */
  borderColor: "rgba(255, 255, 255, 0.5)",
  borderWidth: 1,
  /** RN の StyleSheet には shadow* / elevation を別々に指定する */
  shadowColor: "rgba(62, 39, 35, 0.06)",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 1,
  shadowRadius: 24,
  elevation: 4, // Android
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Brand gradients (CSS string)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * gradient は string で持つ。RN では `expo-linear-gradient` の `LinearGradient`
 * component に色配列で渡す必要があるため、`GRADIENT_RN` を別途用意。
 */
export const GRADIENT = {
  /** primary — section heading underline 等 */
  primary: `linear-gradient(135deg, ${COLOR.sodaText}, ${COLOR.melonText})`,
  /** spectrum — hero / banner */
  spectrum: `linear-gradient(135deg, ${COLOR.sodaBold}, ${COLOR.sodaText}, ${COLOR.melonDeep}, ${COLOR.melonText})`,
  /** page background — soft vanilla → soda → melon */
  pageBg: `linear-gradient(180deg, ${COLOR.bgPrimary}, ${COLOR.sodaLight}88, ${COLOR.melonLight}44, ${COLOR.sodaMid}33)`,
} as const;

/**
 * React Native 用 (`expo-linear-gradient`) の色配列形式。
 * `<LinearGradient colors={GRADIENT_RN.primary} start={{x:0, y:0}} end={{x:1, y:1}}>`
 * のように使う (135deg を `start`/`end` で表現)。
 */
export const GRADIENT_RN = {
  primary: [COLOR.sodaText, COLOR.melonText] as const,
  spectrum: [
    COLOR.sodaBold,
    COLOR.sodaText,
    COLOR.melonDeep,
    COLOR.melonText,
  ] as const,
  pageBg: [
    COLOR.bgPrimary,
    `${COLOR.sodaLight}88`,
    `${COLOR.melonLight}44`,
    `${COLOR.sodaMid}33`,
  ] as const,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Web (desktop) — 派生 token (docs/web/ui-spec-v2.md §2, docs/web/WORKLOG.md #4-#6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Web の CSS font stack。`FONT` は expo-font の登録名なので Web では使えない。
 * 値は docs/design-system.jsx の DS.font と同一 (Pacifico はロゴ専用、CLAUDE.md §6)。
 */
export const FONT_WEB = {
  script: "'Pacifico', cursive",
  heading: "'Quicksand', sans-serif",
  body: "'Quicksand', sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', monospace",
} as const;

/**
 * 2 色の #RRGGBB を t (0..1) で線形補間する。派生 token を既存 token から
 * 作るためのヘルパ (hex 直書きを増やさない)。
 */
export function mixHex(a: string, b: string, t: number): string {
  if (t < 0 || t > 1) throw new RangeError(`t must be in [0, 1], got ${t}`);
  const parse = (h: string): [number, number, number] => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(h)) throw new TypeError(`expected #RRGGBB, got ${h}`);
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  };
  const pa = parse(a);
  const pb = parse(b);
  return (
    "#" +
    pa
      .map((v, i) => Math.round(v + ((pb[i] as number) - v) * t))
      .map((v) => v.toString(16).padStart(2, "0").toUpperCase())
      .join("")
  );
}

/**
 * Web の surface token。water shader の上に載る面は `backdrop-filter` を使わず
 * (docs/web/water-background-spec.md: 毎フレーム再合成を避ける)、
 * bgPrimary (vanilla) の不透明度を上げた near-opaque な面で読みやすさを担保する。
 */
export const SURFACE_WEB = {
  /** Home の portal card / 中央カード (UI v2 §2: 90–95%) — bgPrimary @ 0.92 */
  lobby: withAlpha(COLOR.bgPrimary, 0.92),
  /** work screen の content パネル — bgPrimary @ 0.9 */
  work: withAlpha(COLOR.bgPrimary, 0.9),
  /** global floating nav / local toolbar — bgPrimary @ 0.85 */
  nav: withAlpha(COLOR.bgPrimary, 0.85),
  /** 前面の詳細カード — bgPrimary @ 0.97 */
  detail: withAlpha(COLOR.bgPrimary, 0.97),
  /** 行 hover / 選択中セル — sodaLight @ 0.6 */
  hover: withAlpha(COLOR.sodaLight, 0.6),
  /** 1px の半透明白 border — textOnColor (#FFFFFF) @ 0.7 */
  border: withAlpha(COLOR.textOnColor, 0.7),
  /** 詳細カード背後の薄い scrim — textPrimary @ 0.08 */
  scrim: withAlpha(COLOR.textPrimary, 0.08),
  /**
   * WebGL 非対応 / shader compile 失敗時の page 背景。
   * water spec の #CDEEE3 相当を sodaLight → melonLight の 45% 補間で派生。
   */
  waterFallback: mixHex(COLOR.sodaLight, COLOR.melonLight, 0.45),
} as const;

/** Web の影 (soft / wide、UI v2 §2)。色は COLOR.shadow / shadowStrong 由来。 */
export const SHADOW_WEB = {
  soft: `0 12px 40px ${COLOR.shadowStrong}, 0 2px 8px ${COLOR.shadow}`,
  lift: `0 18px 48px ${COLOR.shadowStrong}, 0 4px 12px ${COLOR.shadow}`,
  inset: `inset 0 0 0 1px ${COLOR.border}`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate `DS` (互換性のため、design-system.jsx の DS object と同形)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 旧形式の `DS.color.sodaText` 等の参照を許容する compat alias。
 *
 * 新規コードでは `COLOR.sodaText` / `FONT.heading` / `SPACE.md` 等の
 * 個別 named export を使うことを推奨 (tree-shaking 時の bundle size 最適化)。
 */
export const DS = {
  color: COLOR,
  font: FONT,
  fontSize: FONT_SIZE,
  weight: WEIGHT,
  space: SPACE,
  radius: RADIUS,
  glass: GLASS,
  glassRN: GLASS_RN,
  gradient: GRADIENT,
  gradientRN: GRADIENT_RN,
  fontWeb: FONT_WEB,
  surfaceWeb: SURFACE_WEB,
  shadowWeb: SHADOW_WEB,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 色 + opacity (0..1) を hex string で混合する簡易ヘルパ。
 *
 * NOTE: 厳密な色変換ではなく、token に opacity 付き variant を生成するための
 * 簡易ツール。複雑な操作には別途 `polished` 等の color library を使うこと。
 *
 * @example
 *   withAlpha(COLOR.sodaText, 0.1) // "#00ACC11A"
 */
export function withAlpha(hex: string, alpha: number): string {
  if (alpha < 0 || alpha > 1) {
    throw new RangeError(`alpha must be in [0, 1], got ${alpha}`);
  }
  // rgba() / rgb() / hsl() などはそのまま返す (透過変換は呼び出し側の責務)
  if (!hex.startsWith("#")) return hex;

  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

  // #RRGGBB → #RRGGBBAA、#RRGGBBAA → 上書き
  if (hex.length === 7) return `${hex}${a}`;
  if (hex.length === 9) return `${hex.slice(0, 7)}${a}`;
  return hex;
}

/**
 * Urgency level に対応する color token を返す。WarningArea / DropletMarker 等で使用。
 *
 * @see CLAUDE.md §6 デザインシステム規約 (Time Event Marker)
 */
export function urgencyColor(urgency: "info" | "watch" | "critical"): string {
  switch (urgency) {
    case "info":
      return COLOR.sodaDeep;
    case "watch":
      return COLOR.caramel;
    case "critical":
      return COLOR.cherryDark;
  }
}
