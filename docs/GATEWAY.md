# JalaDesk Self-Hosted Web Gateway (`Tier 2`)

The JalaDesk Web Gateway bridges browser-based WebSocket sessions (`JSR1`) to native **FreeRDP 3** (`rdp-bridge`), **RFB/VNC** (including Apple Remote Desktop), **SSH PTY**, and **chunked SFTP** inside your private LAN, VPC, or homelab — without exposing `:3389`, `:5900`, or `:22` to the public internet and without storing your vault on the gateway.

## Architecture & Security Model

- **Zero-Knowledge Split Trust:** Your `.jvault` remains encrypted at rest and is decrypted strictly inside your browser's RAM (`docs/app/`). Target credentials are sent transiently over TLS (`wss://`) only when opening a live session and are never persisted by the gateway.
- **256-Bit Session Token + 6-Digit Pairing Code:** On startup the gateway generates a cryptographically random 256-bit bearer token (unless `JALADESK_GATEWAY_TOKEN` is set) and prints a single-use, 5-minute **6-digit Pairing Code** (`5` failed attempts trigger an automatic brute-force lockout).
- **60-Second Single-Use WebSocket Tickets:** Browsers exchange their bearer token via `POST /api/tickets` for a 60-second single-use ticket and pass it in the `Sec-WebSocket-Protocol: ticket.<TICKET>` handshake header. Tokens never appear in URL query strings, browser history, or reverse-proxy access logs, and replayed tickets are rejected with HTTP `401`.
- **SSRF & CIDR Target Policy:** Cloud metadata endpoints (`169.254.169.254`, `169.254.170.2`, `169.254.169.253`, `100.100.100.200`, `fd00:ec2::254`, IPv4-mapped `::ffff:169.254.169.254`, `metadata.google.internal`, `metadata.goog`) are unconditionally blocked, alongside optional operator `JALADESK_GATEWAY_ALLOW_CIDRS` / `JALADESK_GATEWAY_DENY_CIDRS` rules.
- **View-Only Observer Mode & Exclusive Input Lock:** Multiple viewers can observe a live session simultaneously (`viewOnly: true`). Only one viewer holds `controllerId` at a time (`takeControl` / `releaseControl`). If the active controller disconnects or releases control, all held keyboard keys and mouse buttons are automatically released.
- **Zero-Orphan Teardown:** When the last viewer closes or drops its WebSocket, all backend child processes (`rdp-bridge`, `ssh`) and temporary profile directories are terminated and removed immediately.

## Docker Quickstart

```bash
cd outputs/app
docker compose -f docker-compose.gateway.yml up -d --build
docker logs jaladesk-gateway
```

Copy the 6-digit `Pairing Code` printed at startup into the JalaDesk Web App (**Web Gateway -> Pairing Code**) to pair in one step.

> **Note:** `docker-compose.gateway.yml` binds to `127.0.0.1:8443` by default, mounts a `read_only` root filesystem with `cap_drop: [ALL]`, and exposes a `/healthz` Docker healthcheck. Put Caddy or Nginx in front for TLS termination.

## Reverse Proxy TLS Examples

### Caddy

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:8443
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;

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

## Local Development & Demo Mode

Run directly with Node 24+ (zero external npm runtime dependencies):

```bash
npm run build
node dist/src/gateway/server.js --host 127.0.0.1 --port 8443 --serve-ui --demo-session
```

Or via npm script:

```bash
npm run gateway -- --serve-ui --demo-session
```

### CLI Flags & Environment Variables

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--host` | `JALADESK_GATEWAY_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `--port` | `JALADESK_GATEWAY_PORT` | `8443` | Listen port |
| `--token` | `JALADESK_GATEWAY_TOKEN` | random 256-bit hex | Master bearer token |
| `--serve-ui` | `JALADESK_GATEWAY_SERVE_UI` | off | Serve static PWA from `docs/app/` |
| `--demo-session` | `JALADESK_GATEWAY_DEMO` | off | Enable built-in synthetic desktop + SSH/SFTP demo backend |
| `--allow-cidr` | `JALADESK_GATEWAY_ALLOW_CIDRS` | empty | Comma-separated IPv4/IPv6 CIDR allowlist |
| `--deny-cidr` | `JALADESK_GATEWAY_DENY_CIDRS` | empty | Comma-separated IPv4/IPv6 CIDR denylist |
| `--tls-cert`, `--tls-key` | `JALADESK_GATEWAY_TLS_CERT`, `JALADESK_GATEWAY_TLS_KEY` | unset | Optional native HTTPS/WSS certificate pair |
| `--rdp-helper` | `JALADESK_RDP_HELPER` | `native/bin/rdp-bridge` | Path to compiled FreeRDP 3 `rdp-bridge` binary |

## HTTP API Endpoints

- `GET /healthz` -> `{ ok: true, version: "1.17.0", protocol: "JSR1", pairingActive, demoEnabled, activeSessions }`
- `POST /api/pair/exchange` with JSON `{ "code": "123456" }` -> `{ ok: true, token, expiresInSec }` (`401` invalid/expired, `429` lockout after 5 failures)
- `POST /api/tickets` with header `Authorization: Bearer <token>` -> `{ ok: true, ticket, expiresInSec: 60 }` (`401` unauthorized)
- `GET /ws` (WebSocket Upgrade) with `Sec-WebSocket-Protocol: ticket.<TICKET>` (preferred, single-use) or `bearer.<TOKEN>` (`401` on invalid/missing/replayed credentials)

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
