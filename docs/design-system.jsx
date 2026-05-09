import { useState } from "react";

/* ═══════════════════════════════════════════════════════
   SEASONALS DESIGN SYSTEM v2.0
   Cream Soda Edition — Pacifico + Quicksand
   ═══════════════════════════════════════════════════════ */

const DS = {
  /* ── Color Tokens ── */
  color: {
    // Backgrounds
    bgPrimary: "#FFF8E7",          // Vanilla ice cream — main page bg
    bgSecondary: "#F5F0E0",        // Deeper vanilla — alt sections
    bgCard: "rgba(255, 255, 255, 0.35)",
    bgCardHover: "rgba(255, 255, 255, 0.55)",
    bgOverlay: "rgba(224, 247, 250, 0.25)",

    // Brand — Soda Blue (6 steps: bg → text)
    sodaLight: "#E0F7FA",          // Backgrounds, tag fills
    sodaMid: "#B2EBF2",            // Borders, decorative
    sodaDeep: "#80DEEA",           // Icons, secondary accents
    sodaVivid: "#4DD0E1",          // Interactive elements
    sodaBold: "#26C6DA",           // Secondary headings, buttons
    sodaText: "#00ACC1",           // Primary headings, key values

    // Brand — Melon Green (5 steps: bg → text)
    melonLight: "#A8E6CF",         // Backgrounds, tag fills
    melonMid: "#7BD4A8",           // Borders, decorative
    melonDeep: "#56C596",          // Buttons, badges
    melonVivid: "#43A877",         // Positive values
    melonText: "#2E9968",          // Growth, APY, earnings

    // Accent
    caramel: "#C4956A",            // Warm neutral — reinvest
    caramelDark: "#A67B5B",        // Active states
    cherry: "#E57373",             // Alert — maturity warning
    cherryDark: "#D32F2F",         // Urgent alert
    straw: "#FFD54F",              // Highlight — sponsored, new
    strawDark: "#FFC107",          // Active highlight

    // Text
    textPrimary: "#3E2723",        // Deep brown — rare emphasis
    textSubtitle: "#5D4E47",       // Dark — subtitles, body, subheading
    textMuted: "#8D7E76",          // Muted — captions, metadata
    textOnColor: "#FFFFFF",        // On colored backgrounds

    // UI Elements
    border: "rgba(141, 126, 118, 0.12)",
    borderStrong: "rgba(141, 126, 118, 0.25)",
    divider: "rgba(141, 126, 118, 0.08)",
    shadow: "rgba(62, 39, 35, 0.06)",
    shadowStrong: "rgba(62, 39, 35, 0.12)",

    // Semantic
    success: "#2E9968",
    warning: "#C4956A",
    error: "#D32F2F",
    info: "#00ACC1",
  },

  /* ── Typography ── */
  font: {
    script: "'Pacifico', cursive",                    // Logo, brand display
    heading: "'Quicksand', sans-serif",               // Headings, values, UI
    body: "'Quicksand', sans-serif",                  // Body, labels, captions
    mono: "'JetBrains Mono', 'Fira Code', monospace", // Code, hex, data
  },

  /* ── Font Sizes ── */
  fontSize: {
    displayXL: 56,    // Hero logo (Pacifico)
    displayLG: 44,    // Page title
    displayMD: 32,    // Section title
    displaySM: 24,    // Card title
    headingLG: 20,    // Subsection
    headingMD: 17,    // Subheading
    headingSM: 14,    // Label heading
    bodyLG: 16,       // Lead paragraph
    bodyMD: 14,       // Default body
    bodySM: 13,       // Secondary body
    caption: 11,      // Caption, metadata
    overline: 10,     // Section labels (uppercase)
    micro: 9,         // Hex codes, smallest
  },

  /* ── Font Weights (Quicksand) ── */
  weight: {
    bold: 700,
    semibold: 600,
    medium: 500,
    regular: 400,
    light: 300,
  },

  /* ── Spacing ── */
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48, xxxl: 64 },

  /* ── Border Radius ── */
  radius: { sm: 8, md: 12, lg: 16, xl: 20, pill: 100 },

  /* ── Glassmorphism ── */
  glass: {
    background: "rgba(255, 255, 255, 0.35)",
    backdropFilter: "blur(16px)",
    border: "1px solid rgba(255, 255, 255, 0.5)",
    shadow: "0 4px 24px rgba(62, 39, 35, 0.04)",
  },
};


/* ═══════════════════════════════
   HELPERS
   ═══════════════════════════════ */

const Section = ({ title, subtitle, children, id, titleColor }) => (
  <section id={id} style={{ marginBottom: 56 }}>
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{
          width: 24, height: 3, borderRadius: 2,
          background: `linear-gradient(90deg, ${DS.color.sodaText}, ${DS.color.melonText})`,
        }} />
        <span style={{
          fontSize: DS.fontSize.overline, textTransform: "uppercase", letterSpacing: 4,
          color: DS.color.sodaText, fontFamily: DS.font.heading, fontWeight: DS.weight.bold,
        }}>{subtitle}</span>
      </div>
      <h2 style={{
        fontSize: DS.fontSize.displayMD, fontFamily: DS.font.heading, fontWeight: DS.weight.bold,
        color: titleColor || DS.color.sodaText, margin: 0, lineHeight: 1.2, letterSpacing: "-0.02em",
      }}>{title}</h2>
    </div>
    {children}
  </section>
);

const GlassCard = ({ children, style = {} }) => (
  <div style={{
    background: DS.glass.background,
    backdropFilter: DS.glass.backdropFilter,
    WebkitBackdropFilter: DS.glass.backdropFilter,
    border: DS.glass.border,
    borderRadius: DS.radius.lg,
    boxShadow: DS.glass.shadow,
    padding: DS.space.lg,
    ...style,
  }}>
    {children}
  </div>
);

function ColorSwatch({ color, name, token }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(color).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div onClick={handleCopy} style={{ cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 68 }}>
      <div style={{
        width: 52, height: 52, borderRadius: DS.radius.md,
        background: color, border: "1px solid rgba(0,0,0,0.06)",
        boxShadow: `0 2px 8px ${DS.color.shadow}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {copied && <span style={{ fontSize: 9, color: "#fff", fontWeight: 700, textShadow: "0 1px 3px rgba(0,0,0,0.4)" }}>Copied!</span>}
      </div>
      <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted }}>{color}</span>
      <span style={{ fontSize: DS.fontSize.caption, fontFamily: DS.font.body, color: DS.color.textSubtitle, fontWeight: DS.weight.semibold }}>{name}</span>
      <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, opacity: 0.7 }}>{token}</span>
    </div>
  );
}

const BubbleField = ({ count = 15 }) => {
  const bubbles = Array.from({ length: count }, (_, i) => ({
    id: i, size: `${Math.random() * 10 + 4}px`, left: Math.random() * 100,
    delay: Math.random() * 5, duration: Math.random() * 4 + 5,
  }));
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      {bubbles.map((b) => (
        <div key={b.id} style={{
          position: "absolute", bottom: "-10px", left: `${b.left}%`,
          width: b.size, height: b.size, borderRadius: "50%",
          background: "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.95), rgba(255,255,255,0.4))",
          boxShadow: "inset 0 -1px 3px rgba(0,0,0,0.03)",
          animation: `bubbleRise ${b.duration}s ease-in ${b.delay}s infinite`,
          opacity: 0,
        }} />
      ))}
    </div>
  );
};


/* ═══════════════════════════════
   SECTIONS
   ═══════════════════════════════ */

function ColorSection() {
  const groups = [
    { title: "Soda Blue", titleColor: DS.color.sodaText, swatches: [
      { color: DS.color.sodaLight, name: "Soda Light", token: "sodaLight" },
      { color: DS.color.sodaMid, name: "Soda Mid", token: "sodaMid" },
      { color: DS.color.sodaDeep, name: "Soda Deep", token: "sodaDeep" },
      { color: DS.color.sodaVivid, name: "Soda Vivid", token: "sodaVivid" },
      { color: DS.color.sodaBold, name: "Soda Bold", token: "sodaBold" },
      { color: DS.color.sodaText, name: "Soda Text", token: "sodaText" },
    ]},
    { title: "Melon Green", titleColor: DS.color.melonText, swatches: [
      { color: DS.color.melonLight, name: "Melon Light", token: "melonLight" },
      { color: DS.color.melonMid, name: "Melon Mid", token: "melonMid" },
      { color: DS.color.melonDeep, name: "Melon Deep", token: "melonDeep" },
      { color: DS.color.melonVivid, name: "Melon Vivid", token: "melonVivid" },
      { color: DS.color.melonText, name: "Melon Text", token: "melonText" },
    ]},
    { title: "Vanilla Backgrounds", swatches: [
      { color: DS.color.bgPrimary, name: "Vanilla", token: "bgPrimary" },
      { color: DS.color.bgSecondary, name: "Vanilla Deep", token: "bgSecondary" },
      { color: "#FFFFFF", name: "White", token: "#FFFFFF" },
    ]},
    { title: "Accents", swatches: [
      { color: DS.color.caramel, name: "Caramel", token: "caramel" },
      { color: DS.color.caramelDark, name: "Caramel Dk", token: "caramelDark" },
      { color: DS.color.cherry, name: "Cherry", token: "cherry" },
      { color: DS.color.cherryDark, name: "Cherry Dk", token: "cherryDark" },
      { color: DS.color.straw, name: "Straw", token: "straw" },
      { color: DS.color.strawDark, name: "Straw Dk", token: "strawDark" },
    ]},
    { title: "Text", swatches: [
      { color: DS.color.textPrimary, name: "Primary", token: "textPrimary" },
      { color: DS.color.textSubtitle, name: "Subtitle", token: "textSubtitle" },
      { color: DS.color.textMuted, name: "Muted", token: "textMuted" },
    ]},
    { title: "Semantic", swatches: [
      { color: DS.color.success, name: "Success", token: "success" },
      { color: DS.color.warning, name: "Warning", token: "warning" },
      { color: DS.color.error, name: "Error", token: "error" },
      { color: DS.color.info, name: "Info", token: "info" },
    ]},
  ];

  return (
    <Section title="Color Palette" subtitle="Colors" id="colors">
      {groups.map((group, gi) => (
        <div key={gi} style={{ marginBottom: 28 }}>
          <h3 style={{
            fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold,
            color: group.titleColor || DS.color.textSubtitle, margin: "0 0 14px",
          }}>{group.title}</h3>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {group.swatches.map((s, si) => <ColorSwatch key={si} {...s} />)}
          </div>
        </div>
      ))}
      {/* Gradients */}
      <div style={{ marginTop: 8 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.textSubtitle, margin: "0 0 12px" }}>
          Brand Gradients
        </h3>
        {[
          { grad: `linear-gradient(135deg, ${DS.color.sodaText}, ${DS.color.melonText})`, label: "Primary: sodaText → melonText" },
          { grad: `linear-gradient(135deg, ${DS.color.sodaBold}, ${DS.color.sodaText}, ${DS.color.melonDeep}, ${DS.color.melonText})`, label: "Spectrum: sodaBold → melonText" },
          { grad: `linear-gradient(180deg, ${DS.color.bgPrimary}, ${DS.color.sodaLight}88, ${DS.color.melonLight}44, ${DS.color.sodaMid}33)`, label: "Page BG: vanilla → soda → melon" },
        ].map((g, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ height: 36, borderRadius: DS.radius.md, background: g.grad, boxShadow: `0 3px 16px ${DS.color.shadow}` }} />
            <p style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, marginTop: 4 }}>{g.label}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}


function TypographySection() {
  return (
    <Section title="Typography" subtitle="Fonts" id="typography" titleColor={DS.color.melonText}>
      {/* Font families */}
      <GlassCard style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.textSubtitle, margin: "0 0 16px" }}>
          Font Families
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 24 }}>
          {[
            { role: "Script", name: "Pacifico", family: DS.font.script, sample: "Seasonals", desc: "Logo and brand display only. 50s diner-inspired brush script.", weight: 400, color: DS.color.sodaText },
            { role: "Heading", name: "Quicksand", family: DS.font.heading, sample: "$12,847", desc: "Headings, values, buttons, UI labels. Round geometric sans.", weight: 700, color: DS.color.textSubtitle },
            { role: "Body", name: "Quicksand", family: DS.font.body, sample: "Track your yield…", desc: "Body text, subtitles, captions. Same family for cohesion.", weight: 400, color: DS.color.textSubtitle },
            { role: "Mono", name: "JetBrains Mono", family: DS.font.mono, sample: "#00ACC1", desc: "Hex codes, technical data, metadata values.", weight: 400, color: DS.color.textMuted },
          ].map((f, i) => (
            <div key={i}>
              <span style={{
                fontSize: DS.fontSize.overline, textTransform: "uppercase", letterSpacing: 3,
                color: DS.color.sodaText, fontFamily: DS.font.heading, fontWeight: DS.weight.bold,
                display: "block", marginBottom: 6,
              }}>{f.role}</span>
              <p style={{ fontSize: 24, fontFamily: f.family, fontWeight: f.weight, color: f.color, margin: "0 0 4px" }}>{f.sample}</p>
              <p style={{ fontSize: DS.fontSize.caption, fontFamily: DS.font.body, color: DS.color.textMuted, margin: 0, lineHeight: 1.5 }}>{f.desc}</p>
              <p style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, margin: "4px 0 0", opacity: 0.7 }}>{f.name}</p>
            </div>
          ))}
        </div>
      </GlassCard>

      {/* Type scale */}
      <GlassCard style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.textSubtitle, margin: "0 0 16px" }}>
          Type Scale
        </h3>
        {[
          { token: "displayXL", size: 56, family: "script", weight: 400, text: "Seasonals", label: "Hero logo", colorToken: "sodaText", color: DS.color.sodaText },
          { token: "displayLG", size: 44, family: "script", weight: 400, text: "Seasonals", label: "Page logo", colorToken: "sodaText", color: DS.color.sodaText },
          { token: "displayMD", size: 32, family: "heading", weight: 700, text: "Calendar View", label: "Section title", colorToken: "melonText", color: DS.color.melonText },
          { token: "displaySM", size: 24, family: "heading", weight: 700, text: "Portfolio", label: "Card title", colorToken: "sodaText", color: DS.color.sodaText },
          { token: "headingLG", size: 20, family: "heading", weight: 700, text: "Active Positions", label: "Subsection", colorToken: "melonText", color: DS.color.melonText },
          { token: "headingMD", size: 17, family: "heading", weight: 500, text: "Manage your yield across protocols", label: "Subheading", colorToken: "textSubtitle", color: DS.color.textSubtitle },
          { token: "bodyLG", size: 16, family: "body", weight: 400, text: "Track deposits, maturities, and returns across Solana DeFi.", label: "Lead paragraph", colorToken: "textSubtitle", color: DS.color.textSubtitle },
          { token: "bodyMD", size: 14, family: "body", weight: 400, text: "Your next maturity is in 3 days. Consider reinvesting.", label: "Default body", colorToken: "textSubtitle", color: DS.color.textSubtitle },
          { token: "caption", size: 11, family: "body", weight: 600, text: "DEPOSITED · JUN 15 · KAMINO", label: "Caption", colorToken: "textMuted", color: DS.color.textMuted },
          { token: "overline", size: 10, family: "heading", weight: 700, text: "ACTIVE POSITIONS", label: "Overline", colorToken: "sodaText", color: DS.color.sodaText, uppercase: true },
        ].map((item, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "baseline", gap: 16, padding: "10px 0",
            borderBottom: i < 9 ? `1px solid ${DS.color.divider}` : "none",
          }}>
            <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, minWidth: 80 }}>
              {item.size}px
            </span>
            <span style={{
              fontSize: item.size > 36 ? 36 : item.size,
              fontFamily: item.family === "script" ? DS.font.script : item.family === "heading" ? DS.font.heading : DS.font.body,
              fontWeight: item.weight, color: item.color,
              letterSpacing: item.uppercase ? "0.12em" : item.size >= 24 ? "-0.02em" : "-0.01em",
              textTransform: item.uppercase ? "uppercase" : "none",
              flex: 1, lineHeight: 1.3,
            }}>
              {item.text}
            </span>
            <div style={{ minWidth: 90, textAlign: "right" }}>
              <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.body, color: DS.color.textMuted, display: "block" }}>{item.label}</span>
              <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: item.color, opacity: 0.6 }}>{item.colorToken}</span>
            </div>
          </div>
        ))}
      </GlassCard>

      {/* Numeric display */}
      <GlassCard style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.textSubtitle, margin: "0 0 16px" }}>
          Numeric Display
        </h3>
        <div style={{ display: "flex", gap: 36, flexWrap: "wrap" }}>
          {[
            { label: "Portfolio", value: "$12,847", color: DS.color.sodaText },
            { label: "APY", value: "+8.42%", color: DS.color.melonText },
            { label: "Earned", value: "+$1,024", color: DS.color.melonVivid },
            { label: "Days Left", value: "14d", color: DS.color.sodaBold },
          ].map((item, i) => (
            <div key={i}>
              <div style={{ fontSize: DS.fontSize.caption, fontWeight: DS.weight.medium, color: DS.color.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 36, fontWeight: DS.weight.bold, color: item.color, letterSpacing: "-0.03em", fontFamily: DS.font.heading }}>{item.value}</div>
            </div>
          ))}
        </div>
      </GlassCard>

      {/* Color usage guide */}
      <GlassCard>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.textSubtitle, margin: "0 0 14px" }}>
          Font Color Usage
        </h3>
        {[
          { role: "Logo / Brand display", font: "Pacifico", color: DS.color.sodaText, token: "sodaText", sample: "Seasonals" },
          { role: "Section titles / Key values", font: "Quicksand Bold", color: DS.color.sodaText, token: "sodaText", sample: "Portfolio" },
          { role: "Secondary titles / Subsections", font: "Quicksand Bold", color: DS.color.melonText, token: "melonText", sample: "Active Positions" },
          { role: "Subtitles / Body text", font: "Quicksand Regular", color: DS.color.textSubtitle, token: "textSubtitle", sample: "Track your yield" },
          { role: "Captions / Metadata", font: "Quicksand Medium", color: DS.color.textMuted, token: "textMuted", sample: "USDC Vault" },
          { role: "Positive / Growth / APY", font: "Quicksand Bold", color: DS.color.melonText, token: "melonText", sample: "+8.2%" },
          { role: "Warnings / Maturity alert", font: "Quicksand Bold", color: DS.color.cherryDark, token: "cherryDark", sample: "⟶ Jun 15" },
        ].map((item, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 12, padding: "7px 12px",
            borderRadius: DS.radius.sm, background: i % 2 === 0 ? "rgba(255,255,255,0.3)" : "transparent",
          }}>
            <div style={{ width: 20, height: 20, borderRadius: 5, background: item.color, flexShrink: 0 }} />
            <span style={{ fontSize: DS.fontSize.bodySM, fontWeight: DS.weight.semibold, color: item.color, minWidth: 110, fontFamily: item.font.includes("Pacifico") ? DS.font.script : DS.font.heading }}>{item.sample}</span>
            <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, minWidth: 70 }}>{item.token}</span>
            <span style={{ fontSize: DS.fontSize.caption, color: DS.color.textSubtitle, fontWeight: DS.weight.medium, flex: 1, textAlign: "right" }}>{item.role}</span>
          </div>
        ))}
      </GlassCard>
    </Section>
  );
}


function GlassmorphismSection() {
  return (
    <Section title="Glassmorphism" subtitle="Surface" id="glass" titleColor={DS.color.sodaBold}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <div>
          <GlassCard>
            <h4 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.sodaText, margin: "0 0 8px" }}>Standard Card</h4>
            <p style={{ fontSize: DS.fontSize.bodySM, fontFamily: DS.font.body, color: DS.color.textMuted, margin: 0, lineHeight: 1.6 }}>Protocol cards, portfolio widgets, info panels.</p>
          </GlassCard>
          <div style={{ marginTop: 8, padding: "8px 12px", background: `${DS.color.sodaLight}44`, borderRadius: DS.radius.sm }}>
            <p style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, margin: 0, lineHeight: 1.6 }}>
              bg: rgba(255,255,255,0.35) · blur(16px)<br />border: 1px solid rgba(255,255,255,0.5) · radius: {DS.radius.lg}px
            </p>
          </div>
        </div>
        <div>
          <GlassCard style={{ borderLeft: `3px solid ${DS.color.sodaText}` }}>
            <div style={{ fontSize: 36, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.sodaText, lineHeight: 1, marginBottom: 6 }}>$12.8K</div>
            <div style={{ fontSize: DS.fontSize.bodySM, fontFamily: DS.font.body, color: DS.color.textMuted }}>Total portfolio value</div>
          </GlassCard>
          <div style={{ marginTop: 8, padding: "8px 12px", background: `${DS.color.sodaLight}44`, borderRadius: DS.radius.sm }}>
            <p style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, margin: 0 }}>Stat card: border-left 3px solid sodaText</p>
          </div>
        </div>
        <div>
          <GlassCard style={{ borderLeft: `3px solid ${DS.color.melonText}` }}>
            <div style={{ fontSize: 36, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.melonText, lineHeight: 1, marginBottom: 6 }}>+8.2%</div>
            <div style={{ fontSize: DS.fontSize.bodySM, fontFamily: DS.font.body, color: DS.color.textMuted }}>Current APY on Kamino</div>
          </GlassCard>
          <div style={{ marginTop: 8, padding: "8px 12px", background: `${DS.color.melonLight}33`, borderRadius: DS.radius.sm }}>
            <p style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, margin: 0 }}>Earning card: border-left 3px solid melonText</p>
          </div>
        </div>
      </div>
    </Section>
  );
}


function ComponentsSection() {
  return (
    <Section title="UI Components" subtitle="Components" id="components" titleColor={DS.color.melonText}>
      {/* Tags */}
      <GlassCard style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.sodaText, margin: "0 0 14px" }}>Tags / Pills</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          {[
            { label: "Earning", color: DS.color.melonVivid },
            { label: "Staking", color: DS.color.sodaText },
            { label: "Lending", color: DS.color.caramel },
            { label: "Maturity Soon", color: DS.color.cherryDark },
            { label: "+2.4% APY", color: DS.color.melonDeep, filled: true },
            { label: "New", color: DS.color.sodaBold, filled: true },
            { label: "Sponsored", color: DS.color.straw, filled: true, dark: true },
          ].map((tag, i) => (
            <span key={i} style={{
              padding: "5px 14px", borderRadius: DS.radius.pill,
              fontSize: DS.fontSize.caption, fontFamily: DS.font.body, fontWeight: DS.weight.bold,
              color: tag.filled ? (tag.dark ? DS.color.textPrimary : DS.color.textOnColor) : tag.color,
              background: tag.filled ? tag.color : `${tag.color}12`,
              border: `1px solid ${tag.color}${tag.filled ? "00" : "25"}`,
            }}>{tag.label}</span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { label: "Kamino", color: DS.color.sodaText },
            { label: "MarginFi", color: DS.color.melonText },
            { label: "Marinade", color: DS.color.caramel },
          ].map((tag, i) => (
            <span key={i} style={{
              padding: "3px 10px", borderRadius: DS.radius.pill,
              fontSize: DS.fontSize.micro, fontFamily: DS.font.body, fontWeight: DS.weight.bold,
              color: tag.color, background: `${tag.color}0C`, border: `1px solid ${tag.color}18`,
            }}>{tag.label}</span>
          ))}
        </div>
      </GlassCard>

      {/* Buttons */}
      <GlassCard style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.melonText, margin: "0 0 14px" }}>Buttons</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Deposit", bg: `linear-gradient(135deg, ${DS.color.melonDeep}, ${DS.color.melonVivid})`, shadow: DS.color.melonDeep },
            { label: "Withdraw", bg: `linear-gradient(135deg, ${DS.color.sodaVivid}, ${DS.color.sodaText})`, shadow: DS.color.sodaVivid },
            { label: "Reinvest", bg: `linear-gradient(135deg, ${DS.color.caramel}, ${DS.color.caramelDark})`, shadow: DS.color.caramel },
            { label: "Cancel", bg: "rgba(255,255,255,0.5)", color: DS.color.textSubtitle, shadow: "transparent", outline: true },
          ].map((btn, i) => (
            <button key={i} style={{
              padding: "12px 28px", borderRadius: DS.radius.md,
              background: btn.bg, color: btn.outline ? btn.color : DS.color.textOnColor,
              border: btn.outline ? `1px solid ${DS.color.border}` : "none",
              cursor: "pointer", fontFamily: DS.font.heading, fontSize: DS.fontSize.bodyMD,
              fontWeight: DS.weight.bold, boxShadow: `0 4px 16px ${btn.shadow}33`,
            }}>{btn.label}</button>
          ))}
        </div>
      </GlassCard>

      {/* Notifications */}
      <GlassCard style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.sodaText, margin: "0 0 14px" }}>Notifications</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { icon: "⏰", title: "Maturity in 2 days", body: "Kamino USDC Vault — $5,142.30 ready to withdraw or reinvest", color: DS.color.cherryDark, bg: DS.color.cherry },
            { icon: "✨", title: "Yield earned", body: "+$24.80 USDC from MarginFi this week", color: DS.color.melonText, bg: DS.color.melonLight },
            { icon: "💧", title: "New opportunity", body: "Marinade mSOL staking now offering 7.1% APY", color: DS.color.sodaText, bg: DS.color.sodaLight },
          ].map((n, i) => (
            <div key={i} style={{
              padding: "12px 16px", borderRadius: DS.radius.md,
              background: `${n.bg}22`, border: `1px solid ${n.bg}44`,
              display: "flex", gap: 12, alignItems: "center",
            }}>
              <span style={{ fontSize: 18 }}>{n.icon}</span>
              <div>
                <div style={{ fontWeight: DS.weight.bold, fontSize: DS.fontSize.bodyMD, color: n.color, fontFamily: DS.font.heading }}>{n.title}</div>
                <div style={{ fontSize: DS.fontSize.bodySM, color: DS.color.textSubtitle, fontFamily: DS.font.body, marginTop: 2 }}>{n.body}</div>
              </div>
            </div>
          ))}
        </div>
      </GlassCard>

      {/* Dividers */}
      <GlassCard>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.melonText, margin: "0 0 14px" }}>Accent Bars & Dividers</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ height: 4, borderRadius: 2, background: `linear-gradient(90deg, ${DS.color.sodaText}, ${DS.color.melonText})`, opacity: 0.7 }} />
            <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted }}>Primary gradient bar</span>
          </div>
          <div>
            <div style={{ display: "flex", height: 5 }}>
              <div style={{ flex: 1, background: DS.color.sodaBold, borderRadius: "2px 0 0 2px" }} />
              <div style={{ flex: 1, background: DS.color.melonDeep }} />
              <div style={{ flex: 1, background: DS.color.caramel, borderRadius: "0 2px 2px 0" }} />
            </div>
            <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted }}>Three-segment bar</span>
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
            {[DS.color.sodaBold, DS.color.melonDeep, DS.color.caramel].map((c, i) => (
              <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: c, opacity: 0.7 }} />
            ))}
          </div>
          <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, textAlign: "center" }}>Dot separator</span>
        </div>
      </GlassCard>
    </Section>
  );
}


function SpacingSection() {
  return (
    <Section title="Spacing & Radius" subtitle="Layout" id="spacing">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <GlassCard>
          <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.sodaText, margin: "0 0 14px" }}>Spacing</h3>
          {Object.entries(DS.space).map(([key, val]) => (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, minWidth: 36 }}>{key}</span>
              <div style={{ width: val, height: 12, background: `${DS.color.sodaText}22`, borderRadius: 2 }} />
              <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted }}>{val}px</span>
            </div>
          ))}
        </GlassCard>
        <GlassCard>
          <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.melonText, margin: "0 0 14px" }}>Border Radius</h3>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {Object.entries(DS.radius).map(([key, val]) => (
              <div key={key} style={{ textAlign: "center" }}>
                <div style={{ width: 48, height: 48, borderRadius: val, background: `${DS.color.sodaText}10`, border: `1.5px solid ${DS.color.sodaText}22`, marginBottom: 4 }} />
                <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, display: "block" }}>{key}</span>
                <span style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.mono, color: DS.color.textMuted, opacity: 0.6 }}>{val}px</span>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>
    </Section>
  );
}


function PhilosophySection() {
  return (
    <Section title="Philosophy & Mascot" subtitle="Brand" id="philosophy" titleColor={DS.color.sodaText}>
      <GlassCard style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.textSubtitle, margin: "0 0 16px" }}>
          Brand Philosophy
        </h3>
        {[
          { title: "Every season has its harvest.", body: "The deposit→maturity→reinvest cycle mirrors nature's seasons. Seasonals helps users never miss their harvest.", color: DS.color.sodaText, icon: "🌱" },
          { title: "Sip, don't gulp.", body: "Like savoring a cream soda, good asset management is patient and deliberate. Compound growth over reckless trades.", color: DS.color.melonText, icon: "🥤" },
          { title: "Fresh every day.", body: "A calendar is flipped daily. Seasonals makes checking your portfolio feel light, routine, and even enjoyable.", color: DS.color.caramel, icon: "📅" },
        ].map((p, i) => (
          <div key={i} style={{
            padding: "16px 20px", borderRadius: DS.radius.md,
            background: `${p.color}08`, border: `1px solid ${p.color}12`,
            marginBottom: i < 2 ? 12 : 0,
            display: "flex", gap: 16, alignItems: "flex-start",
          }}>
            <span style={{ fontSize: 24, flexShrink: 0, marginTop: 2 }}>{p.icon}</span>
            <div>
              <div style={{
                fontSize: DS.fontSize.headingMD, fontFamily: DS.font.heading, fontWeight: DS.weight.bold,
                color: p.color, marginBottom: 4,
              }}>{p.title}</div>
              <div style={{
                fontSize: DS.fontSize.bodyMD, fontFamily: DS.font.body, fontWeight: DS.weight.regular,
                color: DS.color.textSubtitle, lineHeight: 1.65,
              }}>{p.body}</div>
            </div>
          </div>
        ))}
      </GlassCard>

      <GlassCard>
        <h3 style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.textSubtitle, margin: "0 0 16px" }}>
          Mascot — Soda-kun
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
          {[
            { state: "Earning", desc: "Sipping soda through a straw, eyes sparkling. Yields are flowing.", emoji: "😊🥤", bg: DS.color.melonLight },
            { state: "Maturity Soon", desc: "Fidgeting, bubbles popping around. Time to decide!", emoji: "😳💫", bg: `${DS.color.cherry}20` },
            { state: "Harvest!", desc: "Popping out of the glass with joy. Maturity reached!", emoji: "🎉🍈", bg: `${DS.color.straw}30` },
            { state: "Idle", desc: "Napping in the glass. Assets sitting idle — wake up!", emoji: "😴💤", bg: `${DS.color.sodaLight}` },
          ].map((s, i) => (
            <div key={i} style={{
              padding: "16px", borderRadius: DS.radius.md,
              background: s.bg, textAlign: "center",
            }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>{s.emoji}</div>
              <div style={{ fontSize: DS.fontSize.headingSM, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.sodaText, marginBottom: 4 }}>{s.state}</div>
              <div style={{ fontSize: DS.fontSize.caption, fontFamily: DS.font.body, color: DS.color.textSubtitle, lineHeight: 1.5 }}>{s.desc}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {[
            { season: "Spring", item: "Sakura mochi, cherry blossom soda", emoji: "🌸", bg: `${DS.color.cherry}15` },
            { season: "Summer", item: "Watermelon hat, extra ice cubes", emoji: "🍉", bg: `${DS.color.melonLight}66` },
            { season: "Autumn", item: "Roasted sweet potato, caramel soda", emoji: "🍠", bg: `${DS.color.caramel}20` },
            { season: "Winter", item: "Scarf on, hot chocolate + marshmallow", emoji: "⛄", bg: `${DS.color.sodaLight}` },
          ].map((s, i) => (
            <div key={i} style={{ padding: "12px 10px", borderRadius: DS.radius.md, background: s.bg, textAlign: "center" }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>{s.emoji}</div>
              <div style={{ fontSize: DS.fontSize.caption, fontFamily: DS.font.heading, fontWeight: DS.weight.bold, color: DS.color.sodaText }}>{s.season}</div>
              <div style={{ fontSize: DS.fontSize.micro, fontFamily: DS.font.body, color: DS.color.textMuted, lineHeight: 1.4, marginTop: 2 }}>{s.item}</div>
            </div>
          ))}
        </div>
      </GlassCard>
    </Section>
  );
}


/* ═══════════════════════════════
   MAIN
   ═══════════════════════════════ */
export default function SeasonalsDesignSystem() {
  const [activeNav, setActiveNav] = useState("colors");
  const navItems = [
    { id: "colors", label: "Colors" },
    { id: "typography", label: "Typography" },
    { id: "glass", label: "Glass" },
    { id: "components", label: "Components" },
    { id: "spacing", label: "Spacing" },
    { id: "philosophy", label: "Brand" },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: `linear-gradient(180deg, ${DS.color.bgPrimary} 0%, ${DS.color.sodaLight}88 35%, ${DS.color.melonLight}44 65%, ${DS.color.sodaMid}33 100%)`,
      fontFamily: DS.font.body,
      position: "relative",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Pacifico&family=Quicksand:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style>{`
        @keyframes bubbleRise {
          0% { opacity: 0; transform: translateY(0) scale(0.5); }
          10% { opacity: 0.6; }
          90% { opacity: 0.2; }
          100% { opacity: 0; transform: translateY(-500px) scale(1); }
        }
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${DS.color.sodaMid}; border-radius: 3px; }
      `}</style>

      <BubbleField count={20} />

      {/* Header */}
      <div style={{
        padding: "28px 32px 20px",
        borderBottom: `1px solid ${DS.color.divider}`,
        background: DS.glass.background,
        backdropFilter: DS.glass.backdropFilter,
        WebkitBackdropFilter: DS.glass.backdropFilter,
        position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{
                width: 38, height: 38, borderRadius: DS.radius.md,
                background: `linear-gradient(135deg, ${DS.color.sodaBold}, ${DS.color.melonDeep})`,
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: `0 4px 16px ${DS.color.sodaBold}33`, fontSize: 18,
              }}>🍈</div>
              <h1 style={{
                fontSize: 28, fontFamily: DS.font.script, margin: 0,
                color: DS.color.sodaText,
              }}>Seasonals</h1>
              <span style={{
                fontSize: DS.fontSize.bodySM, fontWeight: DS.weight.regular,
                color: DS.color.textMuted, fontFamily: DS.font.body, marginLeft: 4,
              }}>Design System v2.0</span>
            </div>
            <div style={{
              height: 4, width: 80, borderRadius: 2,
              background: `linear-gradient(90deg, ${DS.color.sodaText}, ${DS.color.melonText})`,
            }} />
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {navItems.map((item) => (
              <a key={item.id} href={`#${item.id}`}
                onClick={(e) => { e.preventDefault(); setActiveNav(item.id); document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth" }); }}
                style={{
                  padding: "6px 14px", borderRadius: DS.radius.pill,
                  fontSize: DS.fontSize.caption, fontFamily: DS.font.heading, fontWeight: DS.weight.bold,
                  textDecoration: "none", transition: "all 0.2s",
                  color: activeNav === item.id ? DS.color.textOnColor : DS.color.textMuted,
                  background: activeNav === item.id
                    ? `linear-gradient(135deg, ${DS.color.sodaBold}, ${DS.color.sodaText})`
                    : "transparent",
                  boxShadow: activeNav === item.id ? `0 2px 8px ${DS.color.sodaBold}33` : "none",
                }}
              >{item.label}</a>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "40px 32px 80px", position: "relative", zIndex: 1 }}>
        <ColorSection />
        <TypographySection />
        <GlassmorphismSection />
        <ComponentsSection />
        <SpacingSection />
        <PhilosophySection />
      </div>
    </div>
  );
}
