# Contributing to JalaDesk

Thank you for your interest in contributing to **JalaDesk**! This repository houses all four synchronized JalaDesk surfaces under one zero-trust architecture:

- **Desktop Studio + 1-Click Web Bridge** (`src/desktop/`, `src/protocols/`, `native/rdp/`)
- **Self-Hosted Zero-Trust Gateway (`JSR1`)** (`src/gateway/`, `deploy/`, `Dockerfile.gateway`)
- **Zero-Knowledge Web PWA** (`docs/app/`)
- **Mobile Companion (`iOS`, `iPadOS` & Android Foldable Flex Mode)** (`mobile/`)

By participating in this project, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). For security issues, please follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

---

## Prerequisites & Local Setup

### 1. Desktop Suite & Self-Hosted Gateway (`Node.js 24+`)

JalaDesk uses native `node:crypto` primitives (including built-in `argon2Sync`, `scryptSync`, and `AES-256-GCM`) and TypeScript 7. **Node.js 24 LTS or newer** is required to match CI (`.github/workflows/ci-verify.yml`).

```bash
git clone https://github.com/ribato22/jaladesk.git
cd jaladesk

# Verify Node.js 24+
node -v

# Install dependencies
npm ci

# Compile TypeScript and run the full automated test suite
npm run build && npm test

# Run the local gateway + bundled Web PWA + synthetic demo session
npm run gateway -- --serve-ui --demo-session

# Launch JalaDesk Desktop Studio
npm start
```

> **Native FreeRDP 3 Bridge (`native/rdp/`):** Building `rdp-bridge` requires CMake 3.21+, a C++17 toolchain, OpenSSL 3, and pinned FreeRDP 3.32.2 (`npm run bootstrap:native && npm run build:native`).

### 2. Mobile Companion (`Flutter 3.x` — Android Foldable & iOS)

```bash
cd mobile

# Fetch packages & run static analysis
flutter pub get
dart analyze lib test

# Run automated unit, viewport, and Android Foldable Flex Mode widget tests
flutter test

# Launch on Android Emulator / Foldable AVD or iOS Simulator
flutter run -d android
flutter run -d ios
```

### 3. Zero-Knowledge Web PWA (`docs/app/`)

The Web PWA is pure zero-dependency ES modules + strict-CSP CSS/HTML served from `docs/app/` (and live at `https://ribato22.github.io/jaladesk/app/`).

```bash
# Serve the Web PWA locally via the built-in gateway with a synthetic demo target
npm run gateway -- --serve-ui --demo-session

# Run the Web PWA, CSP, and gateway regression tests via the root suite
npm run build && npm test
```

---

## Mandatory Engineering Guardrails

Every Pull Request is reviewed and automatically tested against the following non-negotiable standards:

1. **Strict CSP & Zero Unsafe DOM Injection:**
   - **Never** use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or inline `style=""` / `on*=""` attributes in `src/desktop/` or `docs/app/`.
   - Build all DOM nodes declaratively via `document.createElement` + `textContent` and external CSS classes/tokens.
2. **Zero Plaintext Secret Storage & Zero Secret Leakage:**
   - **Never** persist raw passwords, SSH private keys, TOTP seeds, OAuth tokens, or gateway bearer tokens in plaintext files, `localStorage`, URL query parameters, logs, fixtures, or committed `.env` templates.
   - Maintain strict separation between the owner/vault boundary and UI renderers.
3. **Zero SSRF / Container Hardening Regressions:**
   - Gateway changes must preserve unconditional cloud-metadata SSRF blocking (`src/gateway/target-policy.ts`), single-use `Sec-WebSocket-Protocol: ticket.<TICKET>` auth, non-root `read_only` + `cap_drop: [ALL]` container configs, and zero-orphan process teardown.
4. **Design System & Visual Craft Verification (`impeccable`):**
   - Frontend changes across Desktop, Web PWA, and Mobile must adhere to `DESIGN.md` (Sapphire-Gold NOC Midnight palette, WCAG AA contrast, responsive & foldable posture safety).
   - Run `impeccable detect` (or follow the project's design verification checks) before submitting UI changes to verify zero design-system regressions.
5. **100% Automated Verification Before PR:**
   - Core / Gateway / Desktop / Web PWA changes: `npm run build && npm test` must pass with **0 failures**.
   - Mobile changes (`mobile/`): `dart analyze lib test` and `flutter test` must pass with **0 errors/failures**.
   - Add or update regression tests under `tests/` (or `mobile/test/`) for every bug fix, protocol change, deploy-pack edit, or new feature.

---

## Pull Request Workflow

1. Fork the repository and create a focused feature or fix branch from `main` (e.g., `fix/gateway-ticket-expiry` or `feat/foldable-split-deck`).
2. Keep commits atomic and scoped to a single logical change; do not mix unrelated formatting diffs with functional changes.
3. Run all applicable verification commands locally (`npm run build && npm test`, `flutter test`, and `impeccable detect` for UI work).
4. Open a Pull Request against `main` using our [Pull Request Template](./.github/PULL_REQUEST_TEMPLATE.md) and ensure the `CI Verify` GitHub Actions workflow passes cleanly.

---

## Licensing

Contributions to the open-source core of JalaDesk are submitted under the terms of the [Apache License, Version 2.0](./LICENSE). See [docs/ENTERPRISE-LICENSE.md](./docs/ENTERPRISE-LICENSE.md) for the Open-Core boundary.
