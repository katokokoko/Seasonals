# Seasonals Design System — Cream Soda Edition

> 本書は `docs/design-system.jsx` の human-readable / Claude-readable な抜粋。
> 実装中に token を引く際の primary reference。
> source of truth は `design-system.jsx` の `DS` オブジェクト。

---

## 0. ブランド哲学

- **Every season has its harvest.** — deposit→maturity→reinvest cycle は自然の四季を反映
- **Sip, don't gulp.** — クリームソーダのように、資産運用は patient で deliberate
- **Fresh every day.** — カレンダーは毎日めくるもの。Seasonals を見るのが軽くて routine な習慣に

ビジュアルテーマは **クリームソーダ** (vanilla bg + soda blue + melon green、accent に caramel / cherry / straw)。

---

## 1. Color Tokens

### Backgrounds

| token | hex | 用途 |
|---|---|---|
| `bgPrimary` | `#FFF8E7` | Vanilla — メインページ背景 |
| `bgSecondary` | `#F5F0E0` | Deeper vanilla — 別セクション背景 |
| `bgCard` | `rgba(255, 255, 255, 0.35)` | Card 背景 (glassmorphism) |
| `bgCardHover` | `rgba(255, 255, 255, 0.55)` | Card hover |
| `bgOverlay` | `rgba(224, 247, 250, 0.25)` | Overlay |

### Brand — Soda Blue (6 steps)

| token | hex | 用途 |
|---|---|---|
| `sodaLight` | `#E0F7FA` | 背景、tag fill |
| `sodaMid` | `#B2EBF2` | border、装飾 |
| `sodaDeep` | `#80DEEA` | icon、secondary accent |
| `sodaVivid` | `#4DD0E1` | interactive 要素 |
| `sodaBold` | `#26C6DA` | secondary heading、button |
| `sodaText` | `#00ACC1` | **primary heading、key value** |

### Brand — Melon Green (5 steps)

| token | hex | 用途 |
|---|---|---|
| `melonLight` | `#A8E6CF` | 背景、tag fill |
| `melonMid` | `#7BD4A8` | border、装飾 |
| `melonDeep` | `#56C596` | button、badge |
| `melonVivid` | `#43A877` | positive value |
| `melonText` | `#2E9968` | **growth、APY、earnings** |

### Accent

| token | hex | 用途 |
|---|---|---|
| `caramel` | `#C4956A` | 暖色中性 — reinvest |
| `caramelDark` | `#A67B5B` | active state |
| `cherry` | `#E57373` | alert — maturity warning |
| `cherryDark` | `#D32F2F` | urgent alert |
| `straw` | `#FFD54F` | highlight — sponsored、new |
| `strawDark` | `#FFC107` | active highlight |

### Text

| token | hex | 用途 |
|---|---|---|
| `textPrimary` | `#3E2723` | Deep brown — まれな emphasis のみ |
| `textSubtitle` | `#5D4E47` | subtitle、body、subheading |
| `textMuted` | `#8D7E76` | caption、metadata |
| `textOnColor` | `#FFFFFF` | 色背景上のテキスト |

### UI Elements

| token | value |
|---|---|
| `border` | `rgba(141, 126, 118, 0.12)` |
| `borderStrong` | `rgba(141, 126, 118, 0.25)` |
| `divider` | `rgba(141, 126, 118, 0.08)` |
| `shadow` | `rgba(62, 39, 35, 0.06)` |
| `shadowStrong` | `rgba(62, 39, 35, 0.12)` |

### Semantic

| token | hex | 用途 |
|---|---|---|
| `success` | `#2E9968` | (= melonText) |
| `warning` | `#C4956A` | (= caramel) |
| `error` | `#D32F2F` | (= cherryDark) |
| `info` | `#00ACC1` | (= sodaText) |

---

## 2. Brand Gradients

```css
/* Primary gradient — section heading underline 等 */
linear-gradient(135deg, #00ACC1, #2E9968)
/*                      sodaText  melonText  */

/* Spectrum gradient — hero / banner */
linear-gradient(135deg, #26C6DA, #00ACC1, #56C596, #2E9968)
/*                      sodaBold  sodaText  melonDeep melonText */

/* Page background — soft vanilla → soda → melon */
linear-gradient(180deg, #FFF8E7, #E0F7FA88, #A8E6CF44, #B2EBF233)
```

---

## 3. Typography

### Font Families

| role | family | 用途 |
|---|---|---|
| **Script** | `'Pacifico', cursive` | **ロゴ・ブランド表示専用** |
| **Heading** | `'Quicksand', sans-serif` | heading、value、button、UI label |
| **Body** | `'Quicksand', sans-serif` | body、subtitle、caption |
| **Mono** | `'JetBrains Mono', 'Fira Code', monospace` | code、hex、data |

### Pacifico の使用制限
Pacifico はロゴ・ブランド表示専用。**heading / body / UI label には使わない**。
Quicksand を heading と body 共通で使うことで cohesion を保つ。

### Type Scale

| token | size | family | weight | 用途 | 推奨 color |
|---|---|---|---|---|---|
| `displayXL` | 56 | script | 400 | hero logo (Pacifico) | sodaText |
| `displayLG` | 44 | script | 400 | page logo | sodaText |
| `displayMD` | 32 | heading | 700 | section title | sodaText / melonText |
| `displaySM` | 24 | heading | 700 | card title | sodaText |
| `headingLG` | 20 | heading | 700 | subsection | melonText |
| `headingMD` | 17 | heading | 500 | subheading | textSubtitle |
| `headingSM` | 14 | heading | 700 | label heading | textSubtitle |
| `bodyLG` | 16 | body | 400 | lead paragraph | textSubtitle |
| `bodyMD` | 14 | body | 400 | default body | textSubtitle |
| `bodySM` | 13 | body | 400 | secondary body | textSubtitle |
| `caption` | 11 | body | 600 | caption、metadata | textMuted |
| `overline` | 10 | heading | 700 | uppercase section label | sodaText |
| `micro` | 9 | mono | 400 | hex code、smallest | textMuted |

### Numeric Display (重要)

数値表示は **Quicksand Bold + 大型サイズ + tight letter-spacing**:

| 用途 | size | weight | color | example |
|---|---|---|---|---|
| Portfolio total | 36+ | bold | sodaText | `$12,847` |
| APY (positive) | 36+ | bold | melonText | `+8.42%` |
| Earned | 36+ | bold | melonVivid | `+$1,024` |
| Days left | 36+ | bold | sodaBold | `14d` |
| Negative / warning | 36+ | bold | cherryDark | — |

`letter-spacing: -0.03em`、`font-family: Quicksand` を必ず明示。

### Color Usage Guide

| role | font | color token | example |
|---|---|---|---|
| Logo / Brand display | Pacifico | `sodaText` | "Seasonals" |
| Section title / Key value | Quicksand Bold | `sodaText` | "Portfolio" |
| Secondary title / Subsection | Quicksand Bold | `melonText` | "Active Positions" |
| Subtitle / Body | Quicksand Regular | `textSubtitle` | "Track your yield" |
| Caption / Metadata | Quicksand Medium | `textMuted` | "USDC Vault" |
| Positive / Growth / APY | Quicksand Bold | `melonText` | "+8.2%" |
| Warning / Maturity alert | Quicksand Bold | `cherryDark` | "⟶ Jun 15" |

---

## 4. Spacing & Radius

### Spacing

| token | px |
|---|---|
| `xs` | 4 |
| `sm` | 8 |
| `md` | 16 |
| `lg` | 24 |
| `xl` | 32 |
| `xxl` | 48 |
| `xxxl` | 64 |

### Radius

| token | px |
|---|---|
| `sm` | 8 |
| `md` | 12 |
| `lg` | 16 |
| `xl` | 20 |
| `pill` | 100 |

---

## 5. Glassmorphism

### 標準仕様

```css
background: rgba(255, 255, 255, 0.35);
backdrop-filter: blur(16px);
-webkit-backdrop-filter: blur(16px);
border: 1px solid rgba(255, 255, 255, 0.5);
box-shadow: 0 4px 24px rgba(62, 39, 35, 0.04);
border-radius: 16px; /* radius.lg */
padding: 24px;       /* space.lg */
```

すべての標準カードは `GlassCard` component 経由で生成すること。直接 style を書かない。

### Variants

- **Stat card**: `border-left: 3px solid sodaText` を追加
- **Earning card**: `border-left: 3px solid melonText` を追加 (positive 強調)

---

## 6. UI Components

### Tags / Pills

```css
padding: 5px 14px;
border-radius: 100px;          /* radius.pill */
font-size: 11px;               /* fontSize.caption */
font-family: Quicksand;
font-weight: 700;
```

#### Variants

| variant | bg | color | border |
|---|---|---|---|
| Outline (default) | `${color}12` | `color` | `1px solid ${color}25` |
| Filled | `color` | `textOnColor` | `none` |
| Filled dark | `straw` | `textPrimary` | `none` |

#### 用途別 color token

| 用途 | color token |
|---|---|
| Earning | `melonVivid` |
| Staking | `sodaText` |
| Lending | `caramel` |
| Maturity Soon | `cherryDark` |
| New | `sodaBold` (filled) |
| Sponsored | `straw` (filled, dark text) |

### Buttons

```css
padding: 12px 28px;
border-radius: 12px;           /* radius.md */
font-family: Quicksand;
font-size: 14px;
font-weight: 700;
color: textOnColor;
border: none;
box-shadow: 0 4px 16px ${shadow}33;
```

#### Variants

| label | background |
|---|---|
| Deposit | `linear-gradient(135deg, melonDeep, melonVivid)` |
| Withdraw | `linear-gradient(135deg, sodaVivid, sodaText)` |
| Reinvest | `linear-gradient(135deg, caramel, caramelDark)` |
| Cancel (outline) | `rgba(255,255,255,0.5)` + `border: 1px solid border`、color = `textSubtitle` |

### Notifications

```css
padding: 12px 16px;
border-radius: 12px;           /* radius.md */
background: ${color}22;        /* 13% opacity */
border: 1px solid ${color}44;  /* 27% opacity */
display: flex;
gap: 12px;
align-items: center;
```

| type | icon | color (title) | bg color |
|---|---|---|---|
| Maturity alert | ⏰ | `cherryDark` | `cherry` |
| Yield earned | ✨ | `melonText` | `melonLight` |
| New opportunity | 💧 | `sodaText` | `sodaLight` |

### Accent Bars

```css
/* Primary gradient bar */
height: 4px;
border-radius: 2px;
background: linear-gradient(90deg, sodaText, melonText);
opacity: 0.7;

/* Three-segment bar */
height: 5px;
display: flex;
/* segments: sodaBold | melonDeep | caramel */
```

---

## 7. Time Event Marker (droplet)

カレンダーセル上の time event の visual marker。`DropletMarker` component で実装。

§9.3 に基づく 8 カテゴリ × urgency 3 段階のマトリクス。詳細形状は `docs/spec.md` §5.3 / §9.3 参照。

| TimeEventCategory | shape |
|---|---|
| `maturity` | 左に尖った雫ドット (塗りつぶし) |
| `lockup_end` | 左に尖った雫ドット (中抜き) |
| `epoch` | 円形ドット |
| `claim` | 上半円ドット |
| `health` | 警告色の三角ドット |
| `vesting_cliff` | ダイヤモンド型 |
| `vote_deadline` | 旗型 |
| `forecast_marker` | 点線丸 |

加えて補助表示として:
- 預入日 (deposit history): 右に尖った雫ドット (TimeEventCategory ではない)

### Urgency による色付け

| urgency | color token |
|---|---|
| `info` | sodaDeep / sodaMid (落ち着いた色) |
| `watch` | caramel / strawDark |
| `critical` | cherryDark |

### Bubble Field (decoration)

クリームソーダの泡を表現するアニメーション。`BubbleField` component。
背景装飾としてのみ使用、機能要素ではない。

```css
/* radial-gradient で泡の反射を表現 */
background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.95), rgba(255,255,255,0.4));
animation: bubbleRise ${duration}s ease-in ${delay}s infinite;
```

---

## 8. 実装規約

### token 経由のみ
hex 直書き禁止。常に `DS.color.*` を経由する。

```typescript
// ❌
const style = { color: "#00ACC1" };

// ✅
import { DS } from "@/lib/design-system";
const style = { color: DS.color.sodaText };
```

### React Native での扱い
`backdrop-filter` は React Native ではネイティブサポートされない。`expo-blur` の `BlurView` で代替する。

```typescript
import { BlurView } from "expo-blur";

<BlurView intensity={50} tint="light" style={{ borderRadius: 16, ... }}>
  {children}
</BlurView>
```

### Web (Next.js / Vite) での扱い
`backdrop-filter: blur(16px)` をそのまま使用可能。ただし `-webkit-backdrop-filter` も併記する。

### Pacifico の Web Font 配信
- Google Fonts 経由が推奨
- Expo: `expo-font` で読み込み、`Pacifico_400Regular` を `@expo-google-fonts/pacifico` から import
- Quicksand も同様 (`@expo-google-fonts/quicksand`)

---

**End of design-system.md** — source: `design-system.jsx` (DS object)
