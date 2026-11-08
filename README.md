# JalaDesk

**Unified Multi-Protocol Remote Desktop (RDP / VNC), SSH & SFTP Terminal, Cloud Infrastructure & Zero-Trust Operations Suite for macOS, Windows, iOS, iPadOS & Android.**

---

## Overview

**JalaDesk** combines high-performance native remote desktop streaming, an interactive SSH/SFTP terminal workspace, an encrypted zero-trust credential vault, and **46 built-in infrastructure, security, and SRE studios** into a single cohesive platform:

- **Desktop Client (`src/`, `native/`)**: Built on Electron, TypeScript (Strict ESM), and a custom C++17 **FreeRDP 3.x / OpenSSL 3.x** native bridge (`native/rdp/`) with per-session isolated POSIX `0700` / Windows Protected DACL runtime profiles.
- **Mobile Companion (`mobile/`)**: Built with Flutter 3.x (`iOS 16+`, `iPadOS`, `Android 12+`) providing **Jump Desktop-style Fluid Touch RDP/VNC** (precision virtual trackpad + multi-touch pinch-to-zoom + extended `Ctrl`/`Alt`/`⌘`/`F1–F12` modifier strip), **Termius-style Mobile SSH/SFTP**, **RFC 6238 TOTP 2FA**, and **Zero-Trust QR Vault Pairing** (`jaladesk://pair?v=1&...`).

---

## Core Architecture & Capabilities

### 1. Multi-Protocol Remote Access Engine
- **Remote Desktop Protocol (RDP)**: Native C++ FreeRDP 3.x helper bridge with NLA/CredSSP, TLS certificate SHA-256 pinning, dynamic display channel (`disp`) client resize without reconnect, vertical/horizontal high-precision mouse wheel & trackpad pinch-zoom forwarding, opt-in 32 KiB directional UTF-8 clipboard (`cliprdr`), and macOS `⌘ Cmd ⇄ Ctrl` key remapping.
- **VNC / Apple Screen Sharing (RFB 3.8)**: In-tab remote canvas with Fit / Stretch / 1:1 Actual Pixel scaling, View-Only safety lock, and live frame telemetry.
- **SSH Terminal, Bastion Jump Host & Dual-Pane SFTP**: Interactive VT100/xterm terminal emulator, `ProxyJump` (`ssh -J`) bastion chaining, local/remote/SOCKS5 port forwarding, multi-tab Broadcast Input, and dual-pane SFTP Commander.

### 2. Encrypted Documents & Zero-Trust Credential Vault (`.rwdoc` / `.rtsz` / `.jaladesk`)
- **Authenticated Encryption**: `AES-256-GCM` document container with `scrypt` key derivation, atomic write-replace revisions, 3-way field-level conflict resolution, and OS Keychain integration (`macOS Keychain` / `Windows DPAPI` via `safeStorage`).
- **30-Group Hierarchical Inheritance**: Folder-to-connection property inheritance with explicit source provenance, private per-user encrypted overlays, and one-use parameterized connection templates.
- **RFC 6238 TOTP Authenticator**: Built-in `SHA-1` / `SHA-256` / `SHA-512` 6-digit TOTP generator with zero secret readback to renderer processes.
- **Strict Content Security Policy (CSP) & Memory Hygiene**: Renderer processes never access raw file paths or stored secrets; zero `innerHTML` or inline style injection across the entire desktop shell; WCAG-verified dual Light and Dark (`Sapphire-Gold NOC Midnight`) color palettes.

### 3. Enterprise Engineering, Security & SRE Studios (46 Built-in Studios)
Accessible via the **Command Palette (`⌘K`)** or the **Overview Launchpad** across four operational domains:
- **Network, Routing & Deep Diagnostics**: Network Path & DNS (`ping`/`traceroute`/`dig`), Packet Sniffer & BPF (`tcpdump`), Subnet & IPAM Calculator, GeoIP & BGP ASN Whois, Live Topology Map, WireGuard & IPsec VPN Studio, Wake-on-LAN & Port Knocking.
- **Zero-Trust Security & Compliance**: TOTP 2FA Vault, SSH Zero-Trust CA (`ssh-keygen -s`), SSH Key Studio, Secret `.env` Sealer (AES-256-GCM), CIS Hardening Benchmark Auditor, File Integrity Monitoring (`FIM` & `auditd`), TLS Certificate Chain Auditor, Firewall Auditor (`pf`/`ufw`/`nftables`), Fail2Ban & Intrusion Studio, Clipboard Secret Scrubber, and Production Safety Guard (`rm -rf` / `DROP` / `shutdown` interceptor).
- **Fleet, Virtualization & Cloud DevOps**: Hypervisor Studio (Proxmox / VMware / Hyper-V), Container Studio (Docker / Compose), Kubernetes Manifest & Pod Studio, Active Directory & DNS Studio, Systemd / Windows Service Controller, User & Session Audit, OS Patch & CVE Scanner, and IaC / Ansible Inventory Exporter.
- **SRE Observability, HA, DR & ITIL**: Real-Time Resource Profiler, Storage & NVMe SMART Health, Kernel `sysctl` & File Descriptor Limits, HTTP & TLS API Health Probe, Load Benchmark Studio, Prometheus Metrics Scraper, Reverse Proxy Studio (Nginx / Caddy / HAProxy), Database Studio (`psql`/`mysql`/`redis-cli`), Log Tail & Regex Alert Studio, Network Speed & iPerf3 Studio, Cron & Systemd Timer Scheduler, Backup & Restic DR Studio, Incident Runbook & Postmortem Generator, SSL/TLS CSR & SAN Studio, Port & Socket Conflict Resolver (`lsof`), and Cloud Cost FinOps Estimator.

---

## Repository Structure

```text
.
├── src/
│   ├── credentials/       # Zero-trust credential store, generator, analyzer & RFC 6238 TOTP
│   ├── documents/         # AES-256-GCM document container, 3-way merge, revisions & templates
│   ├── protocols/rdp/     # RDP owner lifecycle, wire framing, directional clipboard & profile lease
│   └── desktop/           # Electron main process, strict-CSP renderer, Settings suite & 46 studios
├── native/
│   ├── rdp/               # C++17 FreeRDP 3.x bridge, display/clipboard channels & DACL/0700 guard
│   └── test-server/       # Loopback FreeRDP test server for automated end-to-end verification
├── mobile/                # JalaDesk Mobile (Flutter 3.x for iOS, iPadOS & Android)
│   ├── lib/main.dart      # Touch RDP/VNC canvas, SSH/SFTP console, TOTP 2FA & QR pairing
│   ├── ios/               # Xcode iOS / iPadOS runner (Deployment Target iOS 16.0+)
│   ├── android/           # Gradle Kotlin Android runner
│   └── test/              # Automated Flutter widget test suite
├── scripts/               # Build, native bootstrap, packaging & verification scripts
└── tests/                 # 1,428+ automated Node.js, Electron, CSP, WCAG theme & security tests
```

---

## Getting Started

### Desktop (macOS & Windows)

```bash
# Install dependencies
npm ci

# Compile TypeScript & run the unit test suite (1,428 tests)
npm run build
npm test

# Launch JalaDesk Desktop
npm start
```

### Mobile (iOS, iPadOS & Android)

```bash
cd mobile

# Fetch packages, run static analysis & widget tests
flutter pub get
flutter analyze
flutter test

# Run on iOS Simulator or Android Emulator
flutter run -d ios
flutter run -d android

# Build release bundles for App Store & Google Play
flutter build ipa
flutter build appbundle
```

---

## License

Copyright © Rizky Bachtiar (`@ribato22`). All rights reserved.
