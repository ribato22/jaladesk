# JalaDesk Self-Hosted Web Gateway (`Tier 2` — `JSR1`)

The **JalaDesk Web Gateway** bridges browser-based WebSocket sessions (`JSR1`) to native **FreeRDP 3** (`rdp-bridge`), **RFB/VNC** (including Apple Remote Desktop), **interactive SSH PTY**, and **chunked SFTP** inside your private LAN, VPC, or homelab — without exposing `:3389`, `:5900`, or `:22` to the public internet and without storing your vault on the gateway.

---

## JalaDesk 4-Surface Ecosystem

| Surface | Distribution | Role in Zero-Trust Architecture |
| :--- | :--- | :--- |
| **Desktop Studio + 1-Click Web Bridge** | macOS & Windows (`Electron` + C++17 FreeRDP 3) | Full native multi-protocol desktop client with 46 SRE/SecOps studios and a built-in **1-Click Web Bridge** (`127.0.0.1:8443`) for instant local browser pairing. |
| **Mobile Companion (`v1.17.0`)** | iOS, iPadOS & **Android Foldable Flex Mode** | Adaptive Tabletop Mini-Laptop & Book Mode layouts, precision touch RDP/VNC canvas, SSH/SFTP console, hardware biometric enclave, and RFC 6238 2FA. |
| **Zero-Knowledge Web PWA** | [`https://ribato22.github.io/jaladesk/app/`](https://ribato22.github.io/jaladesk/app/) | Client-side `AES-256-GCM` + `PBKDF2` (`310,000` iterations) browser vault with 1-click Google Drive `appDataFolder` sync, VT100 SSH terminal, SFTP, and live `JSR1` canvas. |
| **Self-Hosted Zero-Trust Gateway (`JSR1`)** | `ghcr.io/ribato22/jaladesk-gateway` (`amd64` / `arm64`) | Stateless TLS/WSS relay running inside your private network or cloud VPC. Zero vault storage, 60-second single-use WS tickets, and strict SSRF/CIDR enforcement. |

---

## Architecture & Security Model

- **Zero-Knowledge Split Trust:** Your `.jvault` remains encrypted at rest and is decrypted strictly inside your browser's RAM (`docs/app/`). Target credentials are sent transiently over TLS (`wss://`) only when opening a live session and are never persisted by the gateway.
- **256-Bit Session Token + 6-Digit Pairing Code:** On startup the gateway generates a cryptographically random 256-bit bearer token (unless `JALADESK_GATEWAY_TOKEN` is set) and prints a single-use, 5-minute **6-digit Pairing Code** (`5` failed attempts trigger an automatic brute-force lockout).
- **60-Second Single-Use WebSocket Tickets:** Browsers exchange their bearer token via `POST /api/tickets` for a 60-second single-use ticket and pass it in the `Sec-WebSocket-Protocol: ticket.<TICKET>` handshake header. Tokens never appear in URL query strings, browser history, or reverse-proxy access logs, and replayed tickets are rejected with HTTP `401`.
- **SSRF & CIDR Target Policy:** Cloud metadata endpoints (`169.254.169.254`, `169.254.170.2`, `169.254.169.253`, `100.100.100.200`, `fd00:ec2::254`, IPv4-mapped `::ffff:169.254.169.254`, `metadata.google.internal`, `metadata.goog`) are unconditionally blocked, alongside optional operator `JALADESK_GATEWAY_ALLOW_CIDRS` / `JALADESK_GATEWAY_DENY_CIDRS` rules.
- **View-Only Observer Mode & Exclusive Input Lock:** Multiple viewers can observe a live session simultaneously (`viewOnly: true`). Only one viewer holds `controllerId` at a time (`takeControl` / `releaseControl`). If the active controller disconnects or releases control, all held keyboard keys and mouse buttons are automatically released.
- **Zero-Orphan Teardown & Hardened Runtime:** All deployment stacks run `jaladesk-gateway` as non-root (`jaladesk`) with `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, and ephemeral `/tmp`. When the last viewer disconnects, all backend processes (`rdp-bridge`, `ssh`) and temporary profiles are terminated immediately.

---

## 60-Second Production Deployment Pack

Choose the deployment target that fits your network perimeter. After startup, open [`https://ribato22.github.io/jaladesk/app/`](https://ribato22.github.io/jaladesk/app/) -> **Web Gateway** and pair with the 6-digit `Pairing Code` printed in the container logs.

### Option 1: VPS / Bare Metal — Docker + Caddy Auto-TLS 1.3 (Recommended for Public DNS)

Provisions automatic Let's Encrypt TLS 1.3 certificates, HSTS/security headers, WebSocket upgrade pass-through, and keeps `jaladesk-gateway` isolated on a private Docker bridge network with **zero exposed host port**.

Files: [`deploy/.env.example`](../deploy/.env.example) · [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile) · [`deploy/caddy/docker-compose.caddy.yml`](../deploy/caddy/docker-compose.caddy.yml)

```bash
cp deploy/.env.example deploy/.env && sed -i.bak 's/gateway.example.com/gateway.yourdomain.com/' deploy/.env && \
  docker compose --env-file deploy/.env -f deploy/caddy/docker-compose.caddy.yml up -d && docker logs jaladesk-gateway
```

### Option 2: Zero-Port-Forwarding — Cloudflare Tunnel (Recommended for NAT / Homelab / Private VPC)

Runs `cloudflare/cloudflared:latest` alongside `jaladesk-gateway` on an internal bridge network with **ZERO open inbound firewall ports**. In Cloudflare Zero Trust (**Networks -> Tunnels**), route your Public Hostname to `http://jaladesk-gateway:8443`.

Files: [`deploy/.env.example`](../deploy/.env.example) · [`deploy/cloudflare/docker-compose.cloudflared.yml`](../deploy/cloudflare/docker-compose.cloudflared.yml)

```bash
cp deploy/.env.example deploy/.env && printf '\nCLOUDFLARE_TUNNEL_TOKEN=PASTE_TOKEN_HERE\n' >> deploy/.env && \
  docker compose --env-file deploy/.env -f deploy/cloudflare/docker-compose.cloudflared.yml up -d && docker logs jaladesk-gateway
```

### Option 3: Fly.io Managed Edge (Auto-TLS + Scale-to-Zero Suspend)

Builds directly from [`Dockerfile.gateway`](../Dockerfile.gateway) with forced HTTPS, `/healthz` checks, and automatic `suspend` when idle (`min_machines_running = 0`).

File: [`fly.gateway.toml`](../fly.gateway.toml)

```bash
fly launch --config fly.gateway.toml --copy-config --no-deploy && \
  fly secrets set JALADESK_GATEWAY_TOKEN="$(openssl rand -hex 32)" && \
  fly deploy --config fly.gateway.toml
```

### Option 4: Railway 1-Click Container

Connect your repository or fork in Railway, point the service config file to [`railway.gateway.json`](../railway.gateway.json), and set `JALADESK_GATEWAY_CORS_ORIGINS=https://ribato22.github.io` (plus optional `JALADESK_GATEWAY_TOKEN` and `JALADESK_GATEWAY_ALLOW_CIDRS`):

```bash
railway up --detach
```

### Option 5: Local Loopback / Desktop 1-Click Web Bridge

For single-workstation usage or pairing with the JalaDesk Web PWA on the same machine:

- **Desktop 1-Click Web Bridge:** Launch JalaDesk Desktop and enable **Web Bridge** — embeds the gateway on `http://127.0.0.1:8443` with a live 6-digit Pairing Code.
- **Loopback Docker Compose:**

```bash
docker compose -f docker-compose.gateway.yml up -d --build && docker logs jaladesk-gateway
```

---

## Multi-Arch Container Registry (GHCR)

Tagged releases (`v*`) automatically publish signed multi-architecture images (`linux/amd64` and `linux/arm64`) with SLSA `provenance: mode=max` and SPDX `sbom: true` attestations via [`.github/workflows/gateway-docker.yml`](../.github/workflows/gateway-docker.yml):

```bash
docker pull ghcr.io/ribato22/jaladesk-gateway:1.17.0
```

---

## Custom Nginx Reverse Proxy Reference

If you terminate TLS on an existing Nginx ingress instead of `deploy/caddy/`:

```nginx
server {
    listen 443 ssl http2;
    server_name gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "DENY" always;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

---

## Local Development & Demo Mode

Run directly with Node 22+ / Node 24+ (zero external npm runtime dependencies):

```bash
npm run build
node dist/src/gateway/server.js --host 127.0.0.1 --port 8443 --serve-ui --demo-session
```

Or via npm script:

```bash
npm run gateway -- --serve-ui --demo-session
```

---

## CLI Flags & Environment Variables

### Gateway Runtime (`src/gateway/server.ts`)

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--host` | `JALADESK_GATEWAY_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker / Fly.io / Railway) |
| `--port` | `JALADESK_GATEWAY_PORT` | `8443` | Listen port |
| `--token` | `JALADESK_GATEWAY_TOKEN` | random 256-bit hex | Master bearer token |
| — | `JALADESK_GATEWAY_CORS_ORIGINS` | `https://ribato22.github.io`, `http://127.0.0.1`, `http://localhost` | Comma-separated allowed browser origins |
| `--serve-ui` | `JALADESK_GATEWAY_SERVE_UI` | `0` (off) | Serve static PWA from `docs/app/` (`1` or `true`) |
| `--demo-session` | `JALADESK_GATEWAY_DEMO` | `0` (off) | Enable built-in synthetic desktop + SSH/SFTP demo backend (`1` or `true`) |
| `--allow-cidr` | `JALADESK_GATEWAY_ALLOW_CIDRS` | empty | Comma-separated IPv4/IPv6 CIDR allowlist for LAN/VPC targets |
| `--deny-cidr` | `JALADESK_GATEWAY_DENY_CIDRS` | empty | Comma-separated IPv4/IPv6 CIDR denylist (metadata endpoints always denied) |
| `--tls-cert`, `--tls-key` | `JALADESK_GATEWAY_TLS_CERT`, `JALADESK_GATEWAY_TLS_KEY` | unset | Optional native HTTPS/WSS certificate pair |
| `--rdp-helper` | `JALADESK_RDP_HELPER` | `native/bin/rdp-bridge` (or `/usr/local/bin/rdp-bridge` in Docker) | Path to compiled FreeRDP 3 `rdp-bridge` binary |

### Deployment Pack Variables (`deploy/.env.example`)

| Environment Variable | Used By | Description |
| :--- | :--- | :--- |
| `JALADESK_GATEWAY_DOMAIN` | `deploy/caddy/` | Public FQDN for automatic Let's Encrypt TLS 1.3 certificates |
| `CLOUDFLARE_TUNNEL_TOKEN` | `deploy/cloudflare/` | Cloudflare Zero Trust Tunnel connector token (`cloudflared`) |

---

## HTTP API Endpoints

- `GET /healthz` -> `200 OK` `{ ok: true, version: "1.17.0", protocol: "JSR1", pairingActive, demoEnabled, activeSessions }`
- `POST /api/pair/exchange` with JSON `{ "code": "123456" }` -> `{ ok: true, token, expiresInSec }` (`401` invalid/expired, `429` lockout after 5 failures)
- `POST /api/tickets` with header `Authorization: Bearer <token>` -> `{ ok: true, ticket, expiresInSec: 60 }` (`401` unauthorized)
- `GET /ws` (WebSocket Upgrade) with `Sec-WebSocket-Protocol: ticket.<TICKET>` (preferred, single-use) or `bearer.<TOKEN>` (`401` on invalid/missing/replayed credentials)

---

## `JSR1` Binary WebSocket Wire Protocol

All WebSocket messages are binary frames starting with 4-byte magic `0x4A 0x53 0x52 0x31` (`"JSR1"`) + 1-byte `msgType`, using big-endian integers:

| Type | Name | Binary Layout |
| :--- | :--- | :--- |
| `0x01` | `FRAME_TILE` | `[magic(4)][0x01(1)][seq(u32)][sentUs(u64)][x(u16)][y(u16)][w(u16)][h(u16)][fullW(u16)][fullH(u16)][codec(u8: 1=PNG, 2=RAW_DEFLATE)][flags(u8: bit0=keyframe)][payloadLen(u32)][payload]` |
| `0x02` | `FRAME_ACK` | `[magic(4)][0x02(1)][seq(u32)][viewerWaitUs(u32)]` |
| `0x03` | `INPUT_EVENT` | `[magic(4)][0x03(1)][kind(u8: 1=move,2=down,3=up,4=wheel,5=keyDown,6=keyUp,7=unicode)][normX(u16: 0..65535)][normY(u16: 0..65535)][codeOrDelta(i32)][flags(u16)][textLen(u16)][utf8Text?]` |
| `0x04` | `CONTROL_JSON` | `[magic(4)][0x04(1)][utf8JsonBytes]` |

### Streaming & Congestion Control

- **64×64 Dirty-Rect PNG Tiles:** Changed tiles are merged into minimal dirty rectangles and encoded to standard PNG (`IHDR` + Sub-filtered zlib `IDAT` + `IEND`), reducing typical 1080p desktop window updates from `8.29 MB` raw RGBA to `< 150 KB` while identical frames emit `0` tiles (idle zero-frame pause).
- **Viewer-Wait-Subtracted Closed-Loop ACK CC:** On every rendered tile, the browser sends `0x02 FRAME_ACK` reporting its local decode/paint time (`viewerWaitUs`). The gateway computes `networkRttUs = max(0, totalRttUs - viewerWaitUs)`, adapts `targetFps` (`5..60`), and pauses capture whenever in-flight unacknowledged frames reach `maxInFlight` (default `3`).
