## Summary

<!-- Briefly describe what this PR changes and why. -->

- **Affected surface(s):** <!-- Desktop macOS/Windows | Android & Foldable | Web PWA | Self-Hosted Gateway JSR1 | Docs/CI -->
- **Related issue(s):** <!-- Closes #... -->

## Verification Performed

- [ ] `npm run build && npm test` passes with **0 failures** (Node.js 24 LTS+)
- [ ] `cd mobile && dart analyze lib test && flutter test` passes (if `mobile/` modified)
- [ ] `impeccable detect` / visual & responsive check verified (if UI modified)
- [ ] Added or updated automated tests covering the change

## Security & Zero-Trust Checklist

- [ ] **Zero plaintext secrets:** No raw passwords, SSH keys, TOTP seeds, OAuth tokens, or gateway bearer tokens persisted, logged, or hardcoded
- [ ] **Strict CSP compliance:** Zero `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or inline `style=""` injections added
- [ ] **Gateway & SSRF boundaries intact:** Cloud metadata endpoints stay blocked, WS tickets stay single-use, and container hardening (`read_only`, `cap_drop: [ALL]`, non-root) is preserved (if gateway/deploy touched)

## Documentation & Governance

- [ ] Updated relevant docs (`README.md`, `docs/GATEWAY.md`, `SECURITY.md`, or `CONTRIBUTING.md`) where behavior, flags, or setup changed
- [ ] Confirmed this PR follows [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
