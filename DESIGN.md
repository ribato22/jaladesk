# DESIGN.md — Remote Workspace RDP Internal (`Precision Pro Desktop`)

## 1. Visual Direction & Philosophy
- **Aesthetic Archetype**: **Precision Pro Desktop** (Linear / Royal TSX / Arc inspired)
- **Mode**: **Adaptive Light & Dark** (`color-scheme: light dark` with full 45-token system parity across `@media (prefers-color-scheme: dark)` and `@media (forced-colors: active)`).
- **Core Tenets**:
  1. **Maximum Canvas & Tree Real Estate**: Top chrome is condensed into a single 44px command bar + 38px tab strip + 38px session bar.
  2. **Progressive Disclosure in Sidebar**: Primary workspace navigation (`#tree`, `#filter`, `#new-conn`, `#new-folder`, `#new-cred`) stays permanently visible and spacious; secondary tools (**Quick Connect** and **Document & Maintenance Actions**) are housed in clean, collapsible `<details class="sidebar-drawer">` panels.
  3. **Scannable Object & Dialog Grids**: The Folder Overview (`#folder-view`) uses a responsive multi-column card grid (`repeat(auto-fill, minmax(220px, 1fr))`) and modal forms (`#conn-dialog`, `#folder-dialog`, `#cred-dialog`) use structured 2-column `.form-grid` layouts.
  4. **Zero-Literal Token Discipline**: Every surface, text hierarchy, border, badge, and 9-color object mark (`--mark-red` through `--mark-gray`) is driven strictly by the 45 verified design tokens in [`theme.ts`](file:///Users/ribato/Documents/APLIKASI/royal-clone/outputs/app/src/desktop/theme.ts) and [`style.css`](file:///Users/ribato/Documents/APLIKASI/royal-clone/outputs/app/src/desktop/style.css).

## 2. Color & Atmospheric Tokens (45-Token System)
All colors reference CSS custom properties defined on `:root`:
- **Surfaces**:
  - `--bg` (`#f6f7f9` Light / `#0f141b` Dark): Primary canvas and workspace backdrop
  - `--surface` (`#ffffff` Light / `#151c26` Dark): Elevated cards, sidebar, and primary containers
  - `--elevated` (`#eef1f5` Light / `#1c2633` Dark): Interactive button surfaces, secondary pills, hover states
  - `--bar` (`#ebeff4` Light / `#121923` Dark): Chrome bars, tab strip, status bar, and table headers
  - `--panel` (`#fbfcfe` Light / `#0b1016` Dark): Deep inset panels, remote session stage, and diagnostic wells
- **Typography & Ink Hierarchy**:
  - `--ink` (`#111827` Light / `#e5ecf6` Dark): Primary titles, active labels, and form values
  - `--muted` (`#4b5563` Light / `#9fb0c7` Dark): Secondary labels, table metadata, and inactive tabs
  - `--subtle` (`#6b7280` Light / `#7c8da5` Dark): Section headers, kbd hints, and empty-state guidance
- **Borders & Focus**:
  - `--line` (`#d6dce5` Light / `#273244` Dark): 1px structural hairlines
  - `--line-strong` (`#b8c2d1` Light / `#394860` Dark): Active input borders, card hover borders, and modal frames
  - `--focus` (`#0f62fe` Light / `#58a6ff` Dark): 2px accessible `:focus-visible` ring
- **Semantic Accents & Status**:
  - `--accent` / `--accent-ink` / `--accent-soft`: Primary CTA buttons, active tree indicators, and selection fills
  - `--ok-*`, `--warn-*`, `--danger-*`: Semantic status pills (`#state`), health banners (`#error`), and destructive actions
- **9 Semantic Object Marks**:
  - `--mark-red`, `--mark-orange`, `--mark-amber`, `--mark-green`, `--mark-teal`, `--mark-blue`, `--mark-indigo`, `--mark-purple`, `--mark-gray` mapped via `[data-color=...]` and blended onto surfaces with `color-mix(in srgb, var(--mark) 12%, var(--surface))`.

## 3. Typography & Scannable Hierarchy
- **UI Sans**: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif` with `-webkit-font-smoothing: antialiased`.
- **Technical Mono**: `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace` with `font-variant-numeric: tabular-nums` for hostnames, ports, Latency/FPS telemetry (`#metrics`), and diagnostic reports.
- **Scale**:
  - Top bar title: `13px` (`font-weight: 650`, `letter-spacing: -.01em`)
  - Section headers (`.section-title`, `th`, `.field-row > span`): `10.5px–11px` uppercase (`font-weight: 700`, `letter-spacing: .05em`)
  - Interactive controls & tree items: `12px–12.5px` (`font-weight: 500–600`)
  - Telemetry badges & kbd hints: `11px` tabular-nums

## 4. Layout Architecture & Viewport Budget
- **App Grid (`#shell`)**: `288px` structured Left Sidebar (`aside`) + `1fr` Multi-Tab Workspace (`main`), collapsing cleanly to single-column below `900px` or hiding chrome automatically in `body.extended` (Fullscreen / Extended View) until keyboard focus or edge hover.
- **Sidebar (`aside`)**:
  - Fixed header with instant filter (`#filter`) and 3 primary creation actions (`+ Connection`, `+ Folder`, `+ Credential`).
  - Flex-grow `#tree` container (`min-height: 220px`) with indent guides, hover elevation, and color-mark indicators.
  - Collapsible bottom drawers (`Quick Connect` and `Document & Actions`) keeping 16 secondary document/maintenance buttons out of the primary visual path until needed.
- **Contextual Main Stage (`main`)**:
  - `#tabs`: Horizontal scrollable tab bar with active bottom indicator (`var(--accent)`) and keyboard/drag reorder cues.
  - `#folder-view`: Hero header + 3-column `#folder-cards` grid + clean tabular `#folder-list` + side-by-side `#credential-panel` & `#Effective` inspector.
  - `#session-bar` & `#view`: Compact 38px session toolbar over a recessed dark/panel canvas with centered overlay card (`#overlay`) and collapsible `#Diagnostics` drawer.

