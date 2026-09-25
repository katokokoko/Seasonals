# Seasonals Web UI / UX Implementation Specification
## Handoff for Claude Code Opus 5.5 (v2)

### Revision notes (v1 → v2)

- Global nav now links to every workspace (Agent, Dashboard, Settings included).
- Chain control is a row of supported-chain icons, not a switcher.
- Timeline is a view inside `/calendar` (`?view=timeline`), with its own component. Not a separate route.
- Home central card: expand button (top-right) opens the workspace; clicking a date or event opens a foreground detail card with the same actions as the Seeker version.
- Home Timeline mode has no month navigation.
- Lobby portal cards show a short description only, no sub-item lists.
- Background follows the existing water shader spec (`water.frag.glsl`); no CSS gradient replacement.
- Blur budget is explicit (§2).
- Typography, tokens, radii, shadows: defer to the repository `design-system.md` / `design-system.jsx`. Missing colors are derived from existing tokens.
- Wallet-not-connected state for Timeline defined (§7).

Read `design-system.md` (or `.jsx`) and the water shader spec before writing any UI code. Where this document and those files disagree on tokens or shader behavior, those files win.

---

### 0. Goal

Implement the next iteration of the Seasonals web UI around one clear product model:

- **Home = lobby / overview / branded entry point**
- **Work screens = focused operational interfaces**
- A **shared floating global top bar** visually connects every screen.
- The Home screen should remain visually distinctive and playful.
- Actual work screens should preserve the same design language but become calmer, denser, and more practical.

Do not redesign the underlying product logic or replace existing integrations unless required. Inspect the current repository first and reuse the existing stack, routing, components, wallet integration, data layer, and design system wherever possible.

---

# 1. Core information architecture

## Global routes

Use the existing route structure if equivalent routes already exist. Otherwise target the following conceptual mapping:

| UI | Route intent |
|---|---|
| Overview / Home | `/` |
| Explore / Menu | `/explore` |
| Calendar workspace (Calendar view) | `/calendar` or `/calendar?view=month` |
| Calendar workspace (Timeline view) | `/calendar?view=timeline` |
| Agent workspace | `/agent` |
| Dashboard workspace | `/dashboard` |
| Settings | `/settings` |

Timeline is a **view of the Calendar workspace**, not a separate route. It gets its own component (`TimelineWorkspace`) but shares the route, the route-level data loading, and the global nav active state with Calendar.

The route names can be adapted to the project's existing router, but the navigation model should remain the same.

### Global top navigation

All major screens share the same floating header. Left to right:

- Seasonals wordmark (links to `/`)
- `Overview`
- `Explore`
- `Calendar`
- `Agent`
- `Dashboard`
- Supported-chain icons (see below)
- `Settings` as an icon-only control (gear), `aria-label="Settings"`, tooltip `Settings`
- Wallet / Connect wallet control

Every workspace is reachable from every other workspace through this bar. Do not rely on Home as the only entry to Agent, Dashboard, or Settings.

Active state:
- `/` → Overview
- `/explore` → Explore
- `/calendar` (any `view`) → Calendar
- `/agent` → Agent
- `/dashboard` → Dashboard
- `/settings` → Settings icon shows active state

If six text items make the bar too wide at the 1100–1439px tier, `Agent` and `Dashboard` may collapse into a `More` menu at that tier only. At ≥ 1440px show all items.

### Supported-chain indicator

This is **not a chain switcher**. It is a compact row of icons showing the chains the app currently supports (for example Solana and Ethereum), rendered from the app's existing chain configuration. Do not hardcode the list.

- each icon has a tooltip with the chain name
- icons are non-interactive in this iteration (no dropdown, no selection state)
- if the app has only one supported chain configured, show that single icon
- if the existing code already has a chain selector with real behavior, keep its behavior but restyle it to match; do not remove working functionality

The top bar must **float inside the viewport with margins on all sides**. It should not look like a browser-native full-width navbar.

---

# 2. Shared visual language

## Source of truth

All tokens come from the repository design system file (`design-system.md` or `design-system.jsx`):

- color tokens
- typography (font families, scale, weights)
- radii
- shadows
- spacing

Do not introduce a parallel palette in this task. If a color needed by a mockup does not exist as a token (for example event-category colors or per-protocol accent colors), **derive it from existing tokens** (tint/shade of an existing token, or an existing token with reduced alpha) and add it to the design system file as a named token with a comment stating what it was derived from. Do not paste arbitrary hex values into components.

For reference only, the family the design system already expresses: vanilla cream surfaces, soda blue, melon green, caramel, warm brown text, cherry red for alerts. Use the actual token values from the file, not values from this document.

## Materials

Primary surfaces:
- cream / white surfaces on top of the water background
- 1px semi-transparent white border
- large radius for floating surfaces (use the design system's large radius token)
- very soft, wide shadow
- avoid hard/dark shadow edges

### Blur budget

`backdrop-filter` is expensive on top of a full-screen shader. Budget:

- `GlobalFloatingNav`: may use `backdrop-filter: blur(16px)`
- `LocalFloatingToolbar` (work screens): may use `backdrop-filter`
- Home lobby portal cards and the central Calendar/Timeline card: **no `backdrop-filter`**. Use a near-opaque cream surface (roughly 90–95% opacity) and rely on the shader's quiet zone beneath the card for calmness.
- Foreground detail card (§4): may use `backdrop-filter` while open, since it is transient
- Maximum of **two persistent blurred surfaces** on screen at any time, plus at most one transient overlay

If the existing implementation already exceeds this, reduce it as part of this task.

Top bars should feel like **floating trays**:
- detached from the screen edges
- generous horizontal padding
- slightly elevated
- rounded
- soft glass/cream surface

Typography:
- follow the design system file exactly (font families, weights, sizes)
- Seasonals wordmark remains the script face defined there
- body/UI text uses the rounded sans defined there
- warm brown text rather than pure black, per the token

## Background behavior

The full-screen background is the existing **water shader** described in the separate shader spec and `water.frag.glsl` (raw WebGL fragment shader, caustics, quiet zones under UI). Use that implementation. Do not replace it with a CSS gradient, image, or video, and do not add three.js / R3F.

### Home
- shader at its full expression
- quiet zones positioned under the global bar, the four portal cards, and the central card
- quiet zone geometry must update when the layout changes (resize, breakpoint tier change, detail card open)
- visually memorable, but the center card must stay readable

### Work screens
- same shader, quieter configuration: widen the quiet zone to cover the entire content region beneath the two-tier header, and reduce caustic intensity via the shader's existing uniforms
- background must never compete with tables, controls, charts, or text
- if the shader spec defines a "calm" preset, use it; otherwise add one there rather than inventing per-screen CSS overrides

Do not convert the app into a dark crypto dashboard.

---

# 3. Home / Lobby screen

## Purpose

The Home screen is not the place for deep operations. It is a **visual overview and navigation lobby**.

It should communicate:
1. Seasonals has a distinctive identity.
2. Calendar/time is the center of the product.
3. Agent, Menu, Dashboard, and Settings are major product spaces.
4. The user can preview information without immediately leaving Home.

## Layout

Below the shared global floating bar:

- center: main Calendar / Timeline card
- top-left: Agent card
- top-right: Menu card
- bottom-left: Setting card
- bottom-right: Dashboard card

The surrounding cards may have a **very subtle rotation** to preserve the "cards resting around a table" feeling. Keep it within about ±2° to ±3°. Do not reproduce the larger tilt seen in concept renders; text readability comes first.

## Portal card content

Each of the four portal cards contains only:
- icon
- title (`Agent`, `Menu`, `Setting`, `Dashboard`)
- one short description line (for example `Your seasonal companion`, `Explore Seasonals`, `Make it yours`, `Your seasonal snapshot`)
- a small chevron / arrow affordance

**No sub-item lists** inside portal cards. Do not list features that the target screen does not actually implement.

---

# 4. Navigation behavior from Home

## Four surrounding cards

Clicking anywhere on the card surface navigates to its work screen:

- Agent → `/agent`
- Menu → `/explore`
- Setting → `/settings`
- Dashboard → `/dashboard`

Requirements:
- the whole card is a single semantic link (`<a>` / router `Link`)
- pointer cursor
- hover: `translateY(-4px)`, slightly stronger shadow, no scale
- active: `translateY(-1px)`
- 180–240ms transition
- keyboard focusable with visible focus ring
- Enter / Space activate

Do not place hidden click targets over the entire viewport.

## Central Calendar / Timeline card

The central card behaves differently. It has three kinds of interaction, and they must not be confused:

1. **Expand** (top-right button) → enters the work screen
2. **Preview interaction** (toggle, prev/next month, hover) → stays on Home, changes only card content
3. **Detail** (click a date or an event) → opens a foreground detail card on top of Home

**Do not navigate to the Calendar workspace when the user clicks calendar content.**

### Expand control

Add an explicit **expand / open workspace button in the top-right corner of the central card**. This is the only control on the card that leaves Home.

Behavior:
- Calendar mode → `/calendar?view=month`
- Timeline mode → `/calendar?view=timeline`

If the application already uses another state/routing scheme, adapt this behavior without duplicating state.

Button:
- diagonal expand arrows or a simple "open workspace" icon
- small circular glass button
- tooltip: `Open full calendar` / `Open full timeline`
- `aria-label` required

### Detail card (date / event click)

Clicking a date cell or an event chip opens a **detail card** that appears in front of everything on Home. This mirrors the event detail behavior in the Seeker (mobile) version. Reuse that version's data shape and action set; do not invent new actions.

Rendering:
- rendered via a portal above the lobby (higher z-index than portal cards and the central card)
- same material family as the other cards, may use `backdrop-filter` (see blur budget)
- anchored near the clicked element on desktop; centered if there is no room
- opens with a 150–200ms fade + small rise; respects reduced motion
- the rest of Home remains visible but does not need to dim heavily; a very light scrim is acceptable

Contents (event click):
- event title, protocol logo/name, category tag
- date, time, chain
- key metrics available for that event (for example estimated reward, APY, TVL), always labeled
- actions, in this priority: the same actions the Seeker version exposes for this event type (for example `Deposit`, `Withdraw`, `View opportunity`, `Add to calendar`), then `Open in calendar` which routes to `/calendar?view=month&date=YYYY-MM-DD`
- close button (`aria-label="Close"`)

Contents (date click):
- the date as heading
- list of that day's events; clicking one swaps the card content to the event detail
- `Open this day in calendar` link
- if the day has no events: `Nothing scheduled.` plus the existing add / explore action

Wallet gating:
- actions that require a connected wallet (`Deposit`, `Withdraw`, etc.) must not execute when disconnected; show the existing `Connect wallet` prompt in their place
- never simulate a transaction result

Dismissal:
- close button
- `Esc`
- click outside the card
- focus is trapped inside the card while open and returns to the triggering element on close
- only one detail card open at a time

This distinction is important:
- expand = enter work mode
- content click = preview / detail, stay on Home

---

# 5. Home Calendar / Timeline switch

Within the central card header, provide:

`Calendar | Timeline`

This toggle changes **only the content inside the central Home card**.

It must not navigate away from Home.

Keep:
- same card dimensions
- same outer frame
- same position on screen
- no layout jump

Use a quick 150–220ms crossfade / slide transition.

---

# 6. Home Calendar mode

Calendar mode is the existing lightweight monthly calendar preview.

Header:
- previous month
- current month label
- next month
- Month / Week / Day controls if already present
- expand button at far right

Content:
- 7-column month grid
- small event tags / droplet markers
- restrained information density
- this is a preview, not the full operational calendar
- date and event clicks open the detail card (§4)

Do not turn the Home calendar into the full three-pane work UI.

---

# 7. NEW: Home Timeline mode

This is a new feature and should be implemented carefully.

## Product concept

Timeline is a **chronological view of the user's assets, positions, events, and protocol-related actions**.

It should combine two visual ideas already explored for Seasonals:

1. the strong sense of time/order from the earlier Timeline/Ladder concept (reference: the SodaCal Timeline screenshot)
2. the clarity and scannability of the chronological operational table / audit-log concept (reference: the SodaCal Admin screenshot)

However, the Home version should be **lighter and more compact** than the full work screen.

## Layout inside the same central card

Keep the outer dimensions of the Home calendar card.

Header in Timeline mode:
- **no month navigation**. Timeline answers "what is coming up next", so month paging does not apply. Hide prev/next and the month label.
- in their place, a static label: `Upcoming` with a light secondary line showing the window, for example `Next 30 days`
- Calendar / Timeline toggle
- expand button

The header height must stay identical between modes so the card does not jump.

Timeline body becomes a compact chronological list/table.

Recommended columns:

```text
Date | Protocol | Asset / Position | Event | Value / Amount | Status
```

On narrower versions of the central card, collapse to:

```text
Date | Protocol + Asset | Event | Status
```

### Window and sorting

- items from now forward, within a fixed window (default 30 days, configurable constant)
- ascending chronological order, nearest first
- stable sort; ties broken by protocol name then title

There is no historical mode on Home. Past items belong to the full workspace.

### Date treatment

The Date column is the visual anchor.

Use:
- date label
- optional time below it
- tiny droplet/event marker
- faint vertical timeline rule connecting rows

This should make the view feel like a timeline rather than a generic spreadsheet.

Example visual hierarchy:

```text
MAY 14
10:00
   ●──── Aave       USDC lending      Reward claim       +$84      Upcoming

MAY 16
08:00
   ●──── Lido       stETH             Reward              +0.12 ETH Upcoming

MAY 20
12:30
   ●──── Jupiter    SOL / USDC        Rebalance                     Planned
```

Do not hard-code these exact examples if real data exists.

### Grouping

If multiple events share the same date:
- show the date once as a date group
- stack event rows under it

### Row interaction

Clicking a row opens the same detail card as §4 for that event.

### Status semantics

Map `TimelineItem.status` to color and a non-color cue:

| status | token family | icon / cue |
|---|---|---|
| `upcoming` | soda blue | droplet outline |
| `planned` (user-scheduled, not yet confirmed on-chain) | caramel | clock |
| `completed` | melon green | check |
| `warning` | caramel | triangle |
| `failed` | cherry red | x |

Use the corresponding existing tokens. Do not use red decoratively.

### Overflow

Home timeline preview should display approximately 5–7 useful rows.

If more rows exist:
- scroll within the card, or
- use a subtle `View more` footer that routes to `/calendar?view=timeline`
- do not grow the entire Home layout vertically

### Wallet not connected

The Timeline is position-centric, so a disconnected wallet has no positions to show. Do not fill it with sample data.

- show only **public, non-wallet-specific time events** the app already tracks (for example token unlocks, epochs, governance votes, seasonal campaigns)
- add a one-line note at the top of the list: `Connect your wallet to see your own positions here.` with the existing connect action
- if no public events exist in the window, fall through to the empty state below

### Empty state

Example:
`No upcoming activity in this period.`

Then offer:
- `Explore opportunities`
- or `Add to calendar`

Use whichever action already exists in the app.

---

# 8. Full Calendar workspace

When the user uses the expand icon or global Calendar navigation, enter the work screen.

## Two-tier floating header

### Tier 1: Global floating bar

Shared across app, as defined in §1.

### Tier 2: Local floating toolbar

A separate floating surface underneath.

Calendar view:
- previous / next
- date/month label
- Month / Week / List
- search/filter controls if needed
- contextual action such as `+ New` only if event creation already exists in the product

Timeline view:
- date range selector (this is where range control lives; Home has none)
- Chronological / Ladder display switch if §9 applies
- filters
- sort controls if useful

A `Calendar | Timeline` view switch lives in the tier-2 toolbar and updates `?view=` without a full navigation.

The second bar must visually read as subordinate to the global bar.

---

# 9. Full Timeline view

Route: `/calendar?view=timeline`. Component: `TimelineWorkspace`, mounted by the Calendar workspace route when `view=timeline`.

The Home Timeline preview and full Timeline view should feel related but not identical.

Full Timeline can expose more operational data:
- Date / time
- Protocol
- Asset / position
- Event/action
- Amount/value
- Network
- Status
- Optional risk / warning state
- Optional simulation / execution state

Prefer a richer chronological table/list for functional use. Past items are allowed here, with a clear `Today` divider.

If the existing Ladder/Gantt timeline is already implemented or valuable, it may become an alternate visualization within the full Timeline view, but **do not force the Home preview into a large Gantt chart**.

Potential switch in the tier-2 toolbar:

```text
Timeline
[Chronological] [Ladder]
```

Only introduce this if it fits naturally with the existing architecture.

---

# 10. Explore / Menu work screen: stronger diner direction

The Menu card opens the Explore screen.

The Explore screen should evolve the current protocol-card catalog into a **refined diner-menu concept**.

Important:
This should feel inspired by a classic diner menu, not like a restaurant-themed gimmick.

## Visual direction

Use:
- warm ivory / vanilla menu surfaces (existing surface tokens)
- teal / aqua diner accents
- melon green highlights
- caramel secondary accents
- thin double-line separators in select areas
- rounded laminated-menu feeling
- subtle ticket / order-slip details
- tiny retro diner motifs only where useful

Avoid:
- black-and-white checkerboard overload
- chrome everywhere
- burger / fries graphics
- heavy 1950s cosplay
- illegible script fonts for body text

Seasonals must still read as a serious DeFi product.

## Screen structure

### Header

Use the shared global bar.

Below it, Menu/Explore gets its own content header:

- `Menu`
- subtitle: `Explore Seasonals`
- optional small line such as `Pick what goes on your calendar.`

### Category navigation

Present protocol categories like menu sections:

- All
- Lending
- Liquidity
- Yield
- Staking
- Perps
- RWA
- Other relevant existing categories

Style these like refined diner menu tabs / laminated category pills.

### Featured strip

Optional:
`Today's Specials`

Use this for genuinely featured / curated products already supported by the product.

Do not fabricate financial claims or imply endorsement.

### Protocol cards / menu items

Desktop: 3–4 columns depending on viewport.

Each item should clearly expose:
- protocol logo
- protocol/product name
- chain
- category
- headline metric (e.g. APY if applicable)
- 1–2 supporting data points
- status/risk/availability tag where existing data supports it
- `View`
- `Add to Calendar` or equivalent existing action

### Diner-menu composition

Borrow the visual hierarchy of a menu item:

```text
[logo] Protocol / Product                    APY 7.8%
       Lending · Solana
       Short metadata / availability
       ----------------------------------------------
       [View details]          [Add to Calendar]
```

The large metric may occupy the visual position where a price would appear on a diner menu, but it must stay clearly labeled as `APY`, `APR`, etc.

Never make a financial metric look like an unlabeled price.

### Special / sponsored state

If sponsored/featured content already exists:
- small `Sponsored` or `Featured` ticket-style pill
- visually clear, not hidden

Do not invent sponsored relationships.

---

# 11. Agent, Dashboard, Settings

These screens are reachable from the global bar and from the Home portal cards, using the same shared shell.

If these screens already exist:
- preserve functionality
- migrate them visually toward the new shared floating-header system
- do not rebuild their business logic

If they do not yet exist:
- scaffold the route and consistent shell
- do not invent complex fake functionality merely to fill the page
- use minimal clearly labeled placeholders until their requirements are defined
- the Home portal card for that screen must still show only title and one description line (§3), so Home never promises features that are not there

---

# 12. Component architecture

Adapt names to the current codebase, but conceptually separate:

```text
AppShell
├── GlobalFloatingNav
│   ├── NavLinks (Overview, Explore, Calendar, Agent, Dashboard)
│   ├── SupportedChainIcons
│   ├── SettingsIconLink
│   └── WalletControl
├── HomeLobby
│   ├── LobbyPortalCard (×4)
│   ├── HomeCalendarCard
│   │   ├── HomeCalendarView
│   │   ├── HomeTimelineView
│   │   ├── CalendarTimelineToggle
│   │   └── ExpandWorkspaceButton
│   └── EventDetailCard (portal, shared with HomeTimelineView rows)
├── WorkspaceShell
│   ├── LocalFloatingToolbar
│   └── WorkspaceContent
├── CalendarWorkspace (route: /calendar)
│   ├── CalendarView (view=month | week | list)
│   └── TimelineWorkspace (view=timeline)
├── AgentWorkspace
├── DashboardWorkspace
├── SettingsScreen
└── ExploreMenu
    ├── MenuCategoryTabs
    ├── FeaturedMenuStrip
    └── ProtocolMenuCard
```

Do not duplicate the global bar between pages. `EventDetailCard` should be the same component the Calendar workspace uses for event detail, if one exists; otherwise create it once and reuse it.

---

# 13. Timeline data model

Prefer existing domain models. If a normalized view model is needed, use something equivalent to:

```ts
type TimelineItem = {
  id: string;
  date: string;          // ISO date/time
  protocol: {
    id?: string;
    name: string;
    logo?: string;
  };
  asset?: string;
  position?: string;
  eventType: string;
  title: string;
  amount?: string;
  fiatValue?: number;
  network?: string;
  status:
    | "upcoming"
    | "planned"
    | "completed"
    | "warning"
    | "failed";
  severity?: "normal" | "attention" | "critical";
  requiresWallet?: boolean;   // false for public events shown when disconnected
};
```

Create derived/grouped data for display rather than changing the source model unnecessarily.

Sort with a stable chronological sort.

---

# 14. Interaction details

## Home portal card hover

```text
idle
→ hover: translateY(-4px), shadow slightly stronger
→ active: translateY(-1px)
```

No scale, no 3D transforms.

## Central Calendar/Timeline toggle

- 150–220ms
- crossfade + tiny horizontal motion
- no card resize

## Expand button

- subtle circular hover fill
- tooltip
- route preserves current view

## Detail card

- open: 150–200ms fade + 4–8px rise
- close: 120ms fade
- focus trap while open, focus restored on close
- `Esc` and outside click close it

## Route transition

Optional:
- very light 150–200ms opacity transition
- no dramatic page animation

## Reduced motion

Respect `prefers-reduced-motion` for all of the above and for the water shader (use the shader spec's reduced-motion behavior).

---

# 15. Responsive behavior

Primary target is desktop.

### ≥ 1440px
Use the full "four cards around center" composition. Global bar shows all nav items.

### 1100–1439px
- reduce rotations toward 0°
- tighten gaps
- keep center card dominant
- side cards may shrink slightly
- global bar may collapse `Agent` and `Dashboard` into `More`

Note: this tier is the most common real-world laptop viewport (a 13-inch MacBook with the browser not full-screen lands here). Treat it as a primary tier, not a fallback.

### < 1100px
Do not force the floating four-corner composition.

Instead:
- top global nav
- central calendar/timeline preview
- Agent / Menu / Dashboard / Settings as a clean 2×2 grid below

### Mobile
If supported:
- no tilted cards
- single-column flow
- simplified floating header
- Timeline uses stacked row cards rather than a six-column table
- detail card becomes a bottom sheet

---

# 16. Accessibility

Required:
- semantic links/buttons
- visible keyboard focus
- `aria-label` on icon-only controls (expand, settings, close, chain icons)
- tooltip for icon-only controls
- sufficient text contrast against cream surfaces
- do not rely on color alone for status (§7 status table)
- touch targets ≥ ~40px where possible
- background animation respects reduced motion
- detail card: `role="dialog"`, `aria-labelledby`, focus trap

---

# 17. Performance constraints

- Reuse existing assets and components.
- The water background is the existing raw-WebGL shader per its spec. Do not add three.js, R3F, or any other 3D library.
- Respect the blur budget in §2.
- Avoid independent expensive animation loops on every bubble/card; decorative motion belongs in the shader, not in DOM animations.
- Quiet-zone updates on resize should be throttled (rAF or ~100ms).
- Lazy-load work-screen-only modules where the current framework makes this straightforward.

---

# 18. Implementation order

Implement in this order:

1. **Inspect repository**
   - current framework/router
   - `design-system.md` / `.jsx` tokens
   - water shader integration and quiet-zone API
   - existing Home
   - Calendar
   - Menu/Explore
   - wallet integration and chain configuration
   - existing event detail component (Seeker parity)
   - existing timeline/log components

2. **Report and confirm**
   - summarize findings and the concrete plan (files to touch, components to create, anything in this spec that conflicts with the codebase)
   - wait for approval before writing UI code

3. **Create/refactor shared `GlobalFloatingNav`**
   - all workspace links, chain icons, settings icon, wallet
   - do not duplicate nav code

4. **Update Home navigation behavior**
   - portal cards become single links with title + description only
   - central card does NOT navigate on general click
   - add explicit top-right expand icon

5. **Implement `EventDetailCard`**
   - date click and event click on Home
   - reuse Seeker action set, wallet gating

6. **Implement Home Calendar/Timeline toggle**
   - preserve card size and header height

7. **Implement Home Timeline chronological preview**
   - normalize/group data
   - date-first hierarchy
   - 5–7-row preview, fixed window, no month nav
   - accessible empty/loading/error/disconnected states

8. **Connect expand behavior**
   - Calendar → `/calendar?view=month`
   - Timeline → `/calendar?view=timeline`

9. **Apply two-tier floating header to work screens**
   - tier-2 view switch for Calendar / Timeline

10. **Restyle Explore/Menu**
   - retain protocol/product clarity
   - increase refined diner-menu personality

11. **Responsive + accessibility pass**

12. **Visual polish**
   - spacing
   - shadows
   - hover
   - transitions
   - shader quiet-zone alignment

---

# 19. Acceptance criteria

The implementation is complete when all of the following are true:

- [ ] Global floating Seasonals bar appears consistently across Home and work screens.
- [ ] Every workspace (Overview, Explore, Calendar, Agent, Dashboard, Settings) is reachable from the global bar on every screen.
- [ ] Chain indicator shows supported chains as icons from configuration, with no switching behavior.
- [ ] Home clearly reads as a lobby, not a dense workspace.
- [ ] Portal cards show only title and one description line, and each navigates to its work screen.
- [ ] Clicking ordinary calendar content on Home does not open the full workspace.
- [ ] Clicking a date or event on Home opens the foreground detail card with the same actions as the Seeker version.
- [ ] Wallet-gated actions in the detail card show the connect prompt when disconnected and never simulate results.
- [ ] Central Home card has a visible expand control in the top-right.
- [ ] Expand in Calendar mode opens `/calendar?view=month`; in Timeline mode opens `/calendar?view=timeline`.
- [ ] Calendar/Timeline switch happens in-place on Home with no card size or header height change.
- [ ] Home Timeline has no month navigation and shows a fixed forward window.
- [ ] Timeline is ordered chronologically and makes Date → Protocol → Asset/Position → Event easy to scan.
- [ ] Multiple events on the same date are grouped coherently.
- [ ] Timeline preview remains lightweight and does not become a dense admin table.
- [ ] Disconnected Timeline shows only public events plus a connect note; no sample data.
- [ ] Work screens use a second local floating toolbar beneath the global bar.
- [ ] Background is the existing water shader on all screens, with quiet zones aligned under UI and a calmer configuration on work screens.
- [ ] No more than two persistent `backdrop-filter` surfaces are on screen at once.
- [ ] All colors and fonts come from the design system file; derived tokens are added there, not inline.
- [ ] Explore/Menu feels more like a refined diner menu while remaining obviously a DeFi catalog.
- [ ] APY/APR/etc. are always explicitly labeled.
- [ ] Existing wallet/data/business logic remains intact.
- [ ] Desktop layout is responsive down to smaller laptop widths, with the 1100–1439px tier looking intentional.
- [ ] Keyboard navigation, focus management in the detail card, and reduced-motion behavior work.

---

# 20. Important non-goals

Do **not**:
- rebuild the entire app from scratch
- replace existing wallet/provider logic
- add fake blockchain transactions or simulated transaction results
- fabricate live financial data or sample positions
- add three.js / R3F or any 3D dependency
- replace the water shader with CSS/image backgrounds
- introduce a second color palette or inline hex values
- make the work screens as visually busy as the Home background
- make the diner concept kitschy
- make Home Timeline a giant Gantt chart
- list sub-features on Home portal cards
- use dark-mode crypto clichés
- use red except for genuine alerts / critical states

---

# 21. Final design principle

The intended product rhythm is:

```text
HOME
beautiful, branded, spatial, exploratory
        ↓
explicit card / expand interaction
        ↓
WORKSPACE
focused, calm, information-dense, operational
```

The same Seasonals identity should survive both contexts.

**Home should make the product memorable.
Workspaces should make the product usable.**
