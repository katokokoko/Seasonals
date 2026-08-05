# AGENTS.md

This file is the entry point for AI development tools that look for `AGENTS.md` by convention (e.g., Codex, [solana.new](https://www.solana.new/) skills, OpenAI / SendAI tooling).

> **The canonical project context for Seasonals lives in [`CLAUDE.md`](./CLAUDE.md).**

All AI agents working on this repository should:

1. **Read `CLAUDE.md` first** for:
   - Naming conventions (§4.4 / CLAUDE.md §2)
   - Numeric encoding rules — token amount as smallest unit string, `bigint` / `decimal.js` for math, no `Number()` for financial values (§4.5 / CLAUDE.md §3)
   - Oracle fail-closed policy — Pyth primary, Switchboard fallback, fail-closed on dual stale or >5% divergence (§4.6 / CLAUDE.md §4)
   - Client stack — Expo + React Native + `@solana-mobile/mobile-wallet-adapter-protocol-web3js` (§4.2 / CLAUDE.md §5)
   - Design system tokens — Cream Soda palette, Pacifico logo only, Quicksand for headings/body (CLAUDE.md §6)
   - Skill usage rules — CLAUDE.md conventions override any skill's recommendations (CLAUDE.md §7; solana.new skills themselves are disabled as of 2026-08-03)
2. **Read `docs/spec.md`** for the full specification (Seasonals Requirements v0.2.15, 3300+ lines)
3. **Read `docs/design-system.md`** for human-readable token reference
4. **Import shared types from `@workspace/lib/types`** — never define types locally in Mobile / BFF / MCP Server. The `lib/` directory is the canonical source-of-truth for `UnifiedTimeEvent`, `AgentPlan`, `ApprovalToken`, `UserPolicy`, `Position`, and all canonical enums (`TimeEventCategory`, `ActionType`, etc.).
5. **Import design tokens from `@workspace/lib/design-system`** — never write hex codes inline.
6. **Use `@workspace/lib/utils/numeric`** for any financial value conversion — `assertTokenAmount`, `toBigInt`, `toHumanReadable`, `formatUsd`, etc.
7. **Follow the §32.2 integrity checklist in `CLAUDE.md` §9** before submitting changes (PR template at `.github/PULL_REQUEST_TEMPLATE.md` enforces this).

## Why this redirect exists

Different AI tools look for context files under different names:

| Tool | Convention |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex / OpenAI tooling | `AGENTS.md` |
| solana.new ecosystem skills | `AGENTS.md` (some) + `CLAUDE.md` (some) |
| Cursor | `.cursorrules` (not used here) |

This `AGENTS.md` ensures all of them route to the same source of truth (`CLAUDE.md`) without duplication. **Do not edit project rules in this file** — edit `CLAUDE.md` instead so the canonical context stays single-sourced.

## Quick start for AI agents

```
1. Read CLAUDE.md  (project rules, ~330 lines)
2. Read docs/spec.md §X.Y as needed (full spec, 3300+ lines)
3. Use the /spec slash command to extract specific sections
4. Run `/check` (or apply CLAUDE.md §9 manually) before committing
```

---

**Canonical: `CLAUDE.md` (synced with `docs/spec.md` v0.2.15)**
