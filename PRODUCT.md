# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

System administrators, infrastructure engineers, DevOps practitioners, and power users on macOS and Windows 11 who manage multiple remote Windows/RDP servers, lab machines, and workstations daily. They work across encrypted workspace documents (`.rwd`), nested connection hierarchies, shared team configurations, and private credential vaults.

## Product Purpose

Remote Workspace is a native-grade desktop RDP workspace and encrypted connection/credential manager (inspired by Royal TSX). It unifies multi-session remote desktop viewing, encrypted document management, hierarchical folder organization, credential inheritance/private overrides, connection templates, and batch operations inside a single workspace window.

## Positioning

Unlike standalone single-window RDP clients that scatter `.rdp` files and plaintext settings across the filesystem, Remote Workspace combines an isolated native FreeRDP engine (`rdp-bridge`) with scrypt-encrypted schema-2 workspace documents, private credential vaults, hierarchical property/credential inheritance, conflict resolution, revision history, and multi-tab live remote sessions with strict security boundaries (explicit certificate SHA-256 pinning, opt-in text-only clipboard, and zero plaintext secret exposure in public UI panels).

## Operating Context

- Runs as an Electron desktop application on macOS (`darwin-arm64`) and Windows 11 (`win32-x64`).
- Operators keep the workspace open for hours, switching rapidly between the navigation tree, quick ad-hoc connections, and multiple live remote desktop canvas tabs.
- Keyboard navigation (shortcuts for tabs `Cmd/Ctrl+1..9`, tree traversal, quick search, releasing keyboard capture from remote canvas) and high scanability are essential.

## Capabilities and Constraints

- **Workspace Documents:** Create, open, save, close, reload, change document password, inspect revision history, resolve save conflicts, and configure autosave (`off`, `close`, `edit`) and document-level group defaults.
- **Navigation Tree & Organization:** Virtualized tree of folders and RDP connections with custom colors (`9` semantic mark colors), icons, favorites, notes, multi-criteria folder sorting, search/filtering, drag-and-drop reordering, and cross-document copy/move (`transfer`).
- **Vault, Credentials & Inheritance:** Private credential vaults, folder/connection effective value inspection, credential binding by ID or exact name/scope, encrypted private overrides, and TOTP/MFA pairing.
- **Templates & Batch Operations:** Reusable connection templates with public token expressions, plus batch create/edit/connect across multiple documents (`max 64 targets`, `2 concurrent starts`).
- **Live RDP Sessions:** Multi-tab remote sessions (`canvas`), dynamic viewport resize, extended fullscreen auto-hide chrome, reconnect/disconnect/cancel controls, and isolated credential prompt dialogs.
- **Technical & Test Contracts:**
  - Strict Content-Security-Policy (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`). No inline styles or inline event handlers.
  - All CSS colors in `src/desktop/style.css` must live exclusively inside the `:root` light palette and `@media (prefers-color-scheme:dark){:root{...}}` dark palette (the `45` semantic tokens verified by `theme.ts` and `shell-theme.test.ts`), satisfying WCAG AA (`4.5:1` text, `3:1` UI signs) across all `87` verified foreground/background pairs.
  - All command-bound control IDs and DOM hooks verified by `shell-commands.test.ts`, `shell-tabs-b3b.test.ts`, `shell-settings-markup.test.ts`, and `shell-c3-document-actions.test.ts` must remain intact.

## Brand Commitments

- **Product Name:** Remote Workspace
- **Language:** Bahasa Indonesia UI copy with precise technical terminology (`Host`, `Port`, `SHA-256`, `Vault`, `Template`, `RDP`).
- **Visual Character:** Precision Pro Desktop (Adaptive Light & Dark) — high-craft desktop workspace with clear visual hierarchy, compact contextual toolbars, scannable multi-column dialogs, and maximum canvas real estate.

## Evidence on Hand

- Full production desktop implementation in `src/desktop/` (`index.html`, `style.css`, `renderer.ts`, `documents-ui.ts`, `shell-ui.ts`, `tabs-ui.ts`, `credentials-ui.ts`, `bulk-ui.ts`, `transfer-ui.ts`, `template-ui.ts`, `settings.html`).
- Verified macOS (`darwin-arm64`) and Windows 11 (`win32-x64`) packaged builds (`0.1.0-internal.3`) and `9/9 PASS_SCOPED` instrumented GUI test suite.

## Product Principles

1. **Canvas & Tree First:** The navigation tree and the active remote desktop canvas are the primary workspace; secondary tools, maintenance controls, and ad-hoc forms must never crowd out tree height or canvas viewport.
2. **Progressive Disclosure Over Button Piles:** Group frequent actions into compact, scannable toolbars and tuck secondary/administrative actions into clean collapsible drawers or structured dialogs.
3. **Adaptive Contrast & Token Discipline:** Every surface, text hierarchy, mark color, and focus ring must remain crisp and WCAG-compliant in both Light and Dark system modes using the canonical palette tokens.
4. **Zero-Friction Security:** Security guarantees (certificate pinning, private password dialogs, clipboard boundaries) are communicated clearly and concisely without noisy walls of warning text.

