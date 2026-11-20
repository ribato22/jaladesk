# Security Policy

**JalaDesk** is built around a strict **Zero-Knowledge, Local-First** security architecture across Desktop (`macOS` & `Windows`), Mobile (`iOS`, `iPadOS` & `Android` Foldable Flex Mode), Zero-Knowledge Web PWA, and the Self-Hosted Web Gateway (`JSR1`).

We appreciate responsible security research and work directly with researchers to validate, remediate, and credit confirmed vulnerabilities.

---

## Supported Versions

Security fixes and cryptographic updates are actively maintained on the following release line:

| Version | Supported | Notes |
| :--- | :--- | :--- |
| `1.17.x` | :white_check_mark: Active | Current production release across Desktop, Mobile (`v1.17.0`), Web PWA, and Self-Hosted Gateway (`JSR1`). |
| `< 1.17.0` | :x: Unsupported | Upgrade to the latest `1.17.x` release or container digest. |

---

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities in public GitHub Issues, Discussions, or Pull Requests.**

Use one of the following private disclosure channels:

1. **GitHub Private Vulnerability Reporting (Preferred):**
   Submit a confidential advisory directly via [GitHub Security Advisories](https://github.com/ribato22/jaladesk/security/advisories/new).
2. **Direct Security Contact:**
   Email **rizkybachtiar7@gmail.com** with `[SECURITY] JalaDesk - <short summary>` in the subject line.

### What to Include

- Affected surface (`Desktop macOS/Windows`, `Mobile iOS/Android`, `Web PWA`, or `Self-Hosted Gateway JSR1`) and exact version / commit SHA / container digest.
- Clear reproduction steps, proof-of-concept payload or configuration, and expected vs. observed security impact.
- Any suggested remediation or mitigation steps (optional).

### Response & Disclosure SLA

| Milestone | Target SLA |
| :--- | :--- |
| **Initial Acknowledgment** | Within **48 hours** of receipt |
| **Triage & Severity Assessment** | Within **7 days** (reproducibility, CVSS impact, and remediation plan) |
| **Status Updates** | At least every **7 days** during active remediation |
| **Coordinated Disclosure** | After a patched release is published (or mutually agreed disclosure window) |

---

## Zero-Knowledge Cryptographic & Runtime Boundary

JalaDesk enforces strict trust boundaries that are continuously verified by our automated test suite (`npm test`):

### 1. Client-Side Authenticated Vault Encryption (`AES-256-GCM`)
- **Desktop Vaults (`.rwdoc` / `.rtsz` / `.jaladesk`):** Sealed with **`AES-256-GCM`** authenticated encryption and **`scrypt`** key derivation using atomic write-replace and OS-native keystores (`macOS Keychain`, `Windows DPAPI`).
- **Web PWA Vaults (`.jvault`):** Decrypted strictly in browser RAM using **`AES-256-GCM`** + **`PBKDF2-HMAC-SHA256`** (`310,000` iterations). Optional Google Drive sync writes only client-side ciphertext to the app-private `drive.appdata` folder.
- **Mobile Vaults:** Protected by hardware-backed biometrics (`Apple Secure Enclave` / `Android Keystore` + `BiometricPrompt`) and a 30-second automatic clipboard secret scrubber.
- **Zero Renderer Secret Exposure:** Passwords, SSH private keys, and RFC 6238 TOTP seeds remain isolated in the main/owner boundary; UI renderers never receive raw secrets or unmasked key material.

### 2. Stateless Self-Hosted Gateway (`JSR1`) — Zero Credential Persistence
- **Zero Vault Storage:** The gateway never stores user vaults, passwords, SSH private keys, or session recordings on disk. Target credentials are transmitted transiently over TLS (`wss://`) strictly to open a live session and are zeroed/released on teardown.
- **Short-Lived Single-Use Tickets:** Clients exchange a 256-bit bearer token (or single-use 5-minute 6-digit Pairing Code with 5-attempt brute-force lockout) via `POST /api/tickets` for a **60-second single-use WebSocket ticket** passed in `Sec-WebSocket-Protocol: ticket.<TICKET>`. Secrets never appear in URL query strings or proxy logs.
- **Container & Process Isolation:** Gateway containers run as non-root (`jaladesk`) with `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, and ephemeral `/tmp`. Native `rdp-bridge` profiles enforce `0700` POSIX permissions or Protected DACL (`TokenUser`) + Windows Job Objects with zero-orphan teardown when viewers disconnect.

### 3. Unconditional SSRF & Cloud Metadata Protection
- The gateway target policy (`src/gateway/target-policy.ts`) unconditionally blocks cloud instance metadata and link-local control endpoints across IPv4, IPv6, IPv4-mapped IPv6, and DNS hostnames — including `169.254.169.254`, `169.254.170.2`, `169.254.169.253`, `100.100.100.200`, `fd00:ec2::254`, `::ffff:169.254.169.254`, `metadata.google.internal`, and `metadata.goog`.
- Operators can further constrain egress targets with `JALADESK_GATEWAY_ALLOW_CIDRS` and `JALADESK_GATEWAY_DENY_CIDRS`, and restrict browser origins via `JALADESK_GATEWAY_CORS_ORIGINS`.

### 4. Strict UI & Content Security Policy Guardrails
- Zero `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, or inline `style=""` injections across Desktop and Web PWA surfaces.
- TLS certificate SHA-256 pinning and Network Level Authentication (`NLA / CredSSP`) supported on native FreeRDP 3 sessions.

---

## Out of Scope

- Vulnerabilities caused by intentionally weakened operator configurations (e.g., running the gateway over plaintext HTTP on public networks, disabling CORS allowlists, or committing populated `.env` secrets to public forks).
- Social engineering, physical device theft with an unlocked OS session, or compromised target hosts outside JalaDesk's process boundary.
