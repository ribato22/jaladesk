import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { Duplex } from 'node:stream';

import {
  ClosedLoopCongestionController,
  Jsr1InputKind,
  Jsr1MsgType,
  Jsr1TileCodec,
  Jsr1TileFlags,
  decodeJsr1Message,
  encodeControlJson,
  encodeFrameAck,
  encodeFrameTile,
  encodeInputEvent,
  type Jsr1DecodedMessage,
  type Jsr1InputEvent,
} from '../src/gateway/wire-protocol.js';
import {
  DirtyRectFrameEncoder,
  encodeRgbaRectToPng,
  pngCrc32,
} from '../src/gateway/frame-encoder.js';
import {
  GatewayAuthManager,
  PairingCodeManager,
  TicketManager,
} from '../src/gateway/auth-tickets.js';
import { TargetPolicy } from '../src/gateway/target-policy.js';
import {
  createGatewayServer,
  type BackendSink,
  type GatewayBackend,
  type GatewaySessionFactory,
} from '../src/gateway/server.js';
import { WsOpcode, computeWebSocketAccept } from '../src/gateway/ws-server.js';

// Minimal RFC 6455 masked client helper for deterministic gateway tests (zero deps)
interface TestWsClient {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  socket: Duplex;
  messages: Jsr1DecodedMessage[];
  sendBinary(payload: Uint8Array): void;
  waitFor(
    predicate: (msg: Jsr1DecodedMessage) => boolean,
    timeoutMs?: number,
  ): Promise<Jsr1DecodedMessage>;
  destroy(): void;
  close(): void;
}

function encodeClientMaskedFrame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.byteLength;
  const mask = randomBytes(4);
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen = 4;
  else if (len > 0xffff) headerLen = 10;

  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  mask.copy(out, headerLen);
  for (let i = 0; i < len; i++) {
    out[headerLen + 4 + i] = payload[i]! ^ mask[i & 3]!;
  }
  return out;
}

function attemptWsUpgrade(
  host: string,
  port: number,
  path: string,
  protocols?: string[],
): Promise<{ upgraded: true; client: TestWsClient } | { upgraded: false; statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const req = http.request({
      host,
      port,
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(protocols && protocols.length > 0 ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
      },
    });

    req.on('error', reject);

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          upgraded: false,
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('upgrade', (res, socket, head) => {
      assert.equal(res.headers['sec-websocket-accept'], computeWebSocketAccept(key));
      const messages: Jsr1DecodedMessage[] = [];
      const waiters: Array<{
        predicate: (msg: Jsr1DecodedMessage) => boolean;
        resolve: (msg: Jsr1DecodedMessage) => void;
      }> = [];
      let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      const parse = (chunk: Buffer) => {
        if (chunk.byteLength === 0) return;
        buf = buf.byteLength === 0 ? chunk : Buffer.concat([buf, chunk]);
        while (buf.byteLength >= 2) {
          const b0 = buf[0]!;
          const b1 = buf[1]!;
          const opcode = b0 & 0x0f;
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.byteLength < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.byteLength < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.byteLength < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = off + len === buf.byteLength ? Buffer.alloc(0) : buf.subarray(off + len);
          if (opcode === WsOpcode.BINARY) {
            const decoded = decodeJsr1Message(payload);
            messages.push(decoded);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i]!.predicate(decoded)) {
                const w = waiters.splice(i, 1)[0]!;
                w.resolve(decoded);
              }
            }
          }
        }
      };

      socket.on('data', parse);
      if (head.byteLength > 0) parse(head);

      const client: TestWsClient = {
        statusCode: 101,
        headers: res.headers,
        socket,
        messages,
        sendBinary(payload: Uint8Array) {
          socket.write(encodeClientMaskedFrame(WsOpcode.BINARY, payload));
        },
        waitFor(predicate, timeoutMs = 3000) {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((resMsg, rejMsg) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === onMatch);
              if (idx >= 0) waiters.splice(idx, 1);
              rejMsg(new Error(`Timed out waiting for JSR1 message (${timeoutMs}ms)`));
            }, timeoutMs);
            const onMatch = (msg: Jsr1DecodedMessage) => {
              clearTimeout(timer);
              resMsg(msg);
            };
            waiters.push({ predicate, resolve: onMatch });
          });
        },
        destroy() {
          socket.destroy();
        },
        close() {
          try {
            socket.write(encodeClientMaskedFrame(WsOpcode.CLOSE, Buffer.from([0x03, 0xe8])));
          } catch {
            // ignore
          }
          socket.end();
        },
      };

      resolve({ upgraded: true, client });
    });

    req.end();
  });
}

function decodeTestPngRgba(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(png.subarray(0, 8), sig, 'PNG signature must match');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idatParts: Buffer[] = [];
  let sawIend = false;

  while (pos < png.byteLength) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('ascii');
    const data = png.subarray(pos + 8, pos + 8 + len);
    const expectedCrc = png.readUInt32BE(pos + 8 + len);
    const actualCrc = pngCrc32(png, pos + 4, 4 + len);
    assert.equal(actualCrc, expectedCrc, `CRC32 mismatch on PNG chunk ${type}`);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6);
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
    }
    pos += 12 + len;
  }

  assert.ok(sawIend, 'PNG must terminate with IEND');
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4 + 1;
  assert.equal(raw.byteLength, stride * height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride]!;
    const srcStart = y * stride + 1;
    const dstStart = y * width * 4;
    for (let i = 0; i < width * 4; i++) {
      if (filter === 0) {
        rgba[dstStart + i] = raw[srcStart + i]!;
      } else if (filter === 1) {
        const left = i >= 4 ? rgba[dstStart + i - 4]! : 0;
        rgba[dstStart + i] = (raw[srcStart + i]! + left) & 0xff;
      } else {
        throw new Error(`Unexpected PNG filter ${filter}`);
      }
    }
  }
  return { width, height, rgba };
}

test('1. JSR1 binary wire protocol roundtrip (FRAME_TILE, FRAME_ACK, INPUT_EVENT, CONTROL_JSON)', () => {
  const tilePayload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const encodedTile = encodeFrameTile({
    seq: 42,
    sentUs: 9_876_543_210n,
    x: 128,
    y: 64,
    w: 320,
    h: 180,
    fullW: 1920,
    fullH: 1080,
    codec: Jsr1TileCodec.PNG,
    flags: Jsr1TileFlags.KEYFRAME,
    payload: tilePayload,
  });
  assert.equal(encodedTile.subarray(0, 4).toString('ascii'), 'JSR1');
  assert.equal(encodedTile[4], Jsr1MsgType.FRAME_TILE);
  const decTile = decodeJsr1Message(encodedTile);
  assert.equal(decTile.type, Jsr1MsgType.FRAME_TILE);
  assert.equal(decTile.tile.seq, 42);
  assert.equal(decTile.tile.sentUs, 9_876_543_210n);
  assert.equal(decTile.tile.x, 128);
  assert.equal(decTile.tile.y, 64);
  assert.equal(decTile.tile.w, 320);
  assert.equal(decTile.tile.h, 180);
  assert.equal(decTile.tile.fullW, 1920);
  assert.equal(decTile.tile.fullH, 1080);
  assert.equal(decTile.tile.codec, Jsr1TileCodec.PNG);
  assert.equal(decTile.tile.flags, Jsr1TileFlags.KEYFRAME);
  assert.deepEqual(Buffer.from(decTile.tile.payload), tilePayload);

  const encodedAck = encodeFrameAck({ seq: 42, viewerWaitUs: 4_500 });
  assert.equal(encodedAck.byteLength, 13);
  const decAck = decodeJsr1Message(encodedAck);
  assert.equal(decAck.type, Jsr1MsgType.FRAME_ACK);
  assert.equal(decAck.ack.seq, 42);
  assert.equal(decAck.ack.viewerWaitUs, 4_500);

  const encodedInput = encodeInputEvent({
    kind: Jsr1InputKind.UNICODE,
    normX: 32768,
    normY: 16384,
    codeOrDelta: -120,
    flags: 0x0003,
    text: '482910',
  });
  const decInput = decodeJsr1Message(encodedInput);
  assert.equal(decInput.type, Jsr1MsgType.INPUT_EVENT);
  assert.equal(decInput.input.kind, Jsr1InputKind.UNICODE);
  assert.equal(decInput.input.normX, 32768);
  assert.equal(decInput.input.normY, 16384);
  assert.equal(decInput.input.codeOrDelta, -120);
  assert.equal(decInput.input.flags, 3);
  assert.equal(decInput.input.text, '482910');

  const encodedCtrl = encodeControlJson({ type: 'open', protocol: 'rdp', host: '10.0.0.5', port: 3389 });
  const decCtrl = decodeJsr1Message(encodedCtrl);
  assert.equal(decCtrl.type, Jsr1MsgType.CONTROL_JSON);
  assert.equal(decCtrl.control.type, 'open');
  assert.equal(decCtrl.control.host, '10.0.0.5');

  assert.throws(() => decodeJsr1Message(Buffer.from('NOPE\x01')), /magic/);
  assert.throws(() => decodeJsr1Message(Buffer.from('JSR1\x02\x00\x01')), /FRAME_ACK/);
});

test('2. Dirty-rect PNG encoder: 1080p 320x180 delta < 150 KB, lossless PNG, and idle zero-frame pause', () => {
  const width = 1920;
  const height = 1080;
  const rawBytes = width * height * 4;
  assert.equal(rawBytes, 8_294_400);

  const frame1 = new Uint8Array(rawBytes);
  // Fill realistic desktop background (dark slate with top panel)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const top = y < 40;
      frame1[i] = top ? 30 : 15;
      frame1[i + 1] = top ? 41 : 23;
      frame1[i + 2] = top ? 59 : 42;
      frame1[i + 3] = 255;
    }
  }

  const encoder = new DirtyRectFrameEncoder();
  const keyTiles = encoder.encodeFrame(frame1, width, height);
  assert.equal(keyTiles.length, 1);
  assert.equal(keyTiles[0]!.flags, Jsr1TileFlags.KEYFRAME);
  assert.equal(keyTiles[0]!.w, width);
  assert.equal(keyTiles[0]!.h, height);

  // Identical frame -> idle zero-frame pause (0 tiles!)
  const idleTiles = encoder.encodeFrame(frame1, width, height);
  assert.equal(idleTiles.length, 0, 'Identical frame must emit 0 tiles');

  // Update a typical 320x180 window region with varied UI stripes/text blocks
  const frame2 = new Uint8Array(frame1);
  const ux = 256;
  const uy = 192;
  const uw = 320;
  const uh = 180;
  for (let y = uy; y < uy + uh; y++) {
    for (let x = ux; x < ux + uw; x++) {
      const i = (y * width + x) * 4;
      const isHeader = y < uy + 32;
      const isLine = (y % 18 === 0 || x % 24 === 0) && !isHeader;
      frame2[i] = isHeader ? 37 : isLine ? 56 : 24;
      frame2[i + 1] = isHeader ? 99 : isLine ? 189 : 34;
      frame2[i + 2] = isHeader ? 235 : isLine ? 248 : 54;
      frame2[i + 3] = 255;
    }
  }

  const deltaTiles = encoder.encodeFrame(frame2, width, height);
  assert.ok(deltaTiles.length >= 1, 'Changed 320x180 window must emit dirty tile(s)');
  const totalPayloadBytes = deltaTiles.reduce((sum, t) => sum + t.payload.byteLength, 0);
  assert.ok(
    totalPayloadBytes < 150 * 1024,
    `1080p 320x180 dirty-rect PNG payload must be < 150 KB, got ${totalPayloadBytes} bytes`,
  );

  // Verify PNG decodability and pixel-exact lossless roundtrip on a small rect
  const smallPng = encodeRgbaRectToPng(frame2, width, height, ux, uy, 64, 64);
  const decoded = decodeTestPngRgba(smallPng);
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 64);
  for (let ry = 0; ry < 64; ry++) {
    for (let rx = 0; rx < 64; rx++) {
      const src = ((uy + ry) * width + (ux + rx)) * 4;
      const dst = (ry * 64 + rx) * 4;
      assert.equal(decoded.rgba[dst], frame2[src]);
      assert.equal(decoded.rgba[dst + 1], frame2[src + 1]);
      assert.equal(decoded.rgba[dst + 2], frame2[src + 2]);
      assert.equal(decoded.rgba[dst + 3], frame2[src + 3]);
    }
  }

  // Subsequent identical frame2 -> 0 tiles again
  assert.equal(encoder.encodeFrame(frame2, width, height).length, 0);
});

test('3. ClosedLoopCongestionController subtracts viewerWaitUs & enforces maxInFlight pause', () => {
  let fakeNow = 1_000_000n;
  const cc = new ClosedLoopCongestionController({
    initialFps: 30,
    minFps: 5,
    maxFps: 60,
    maxInFlight: 3,
    nowUs: () => fakeNow,
  });

  // Send 3 frames -> reaches maxInFlight -> capture pauses!
  assert.equal(cc.canSend(), true);
  cc.onFrameSent(1, fakeNow);
  cc.onFrameSent(2, fakeNow + 1_000n);
  cc.onFrameSent(3, fakeNow + 2_000n);
  assert.equal(cc.canSend(), false, 'Capture must pause when inFlight >= maxInFlight (3)');
  assert.equal(cc.isPaused(), true);

  // Frame 1 takes 150ms total RTT, but 140ms was slow browser paint (`viewerWaitUs`),
  // so true network RTT is only 10ms -> FPS must increase instead of collapsing!
  fakeNow = 1_150_000n;
  const ack1 = cc.onFrameAck(1, 140_000, fakeNow);
  assert.equal(ack1.matched, true);
  assert.equal(ack1.totalRttUs, 150_000);
  assert.equal(ack1.networkRttUs, 10_000);
  assert.ok(ack1.targetFps > 30, `Slow browser with 10ms network RTT should ramp FPS up, got ${ack1.targetFps}`);
  assert.equal(cc.canSend(), true, 'ACK frees in-flight slot');

  // Frame 2 experiences real 200ms network congestion (viewerWaitUs = 5ms -> networkRtt = 194ms)
  fakeNow = 1_201_000n;
  const fpsBeforeCongestion = cc.getTargetFps();
  const ack2 = cc.onFrameAck(2, 5_000, fakeNow);
  assert.equal(ack2.networkRttUs, 195_000);
  assert.ok(ack2.targetFps < fpsBeforeCongestion, 'High real network RTT must back off targetFps');
  assert.ok(ack2.targetFps >= 5 && ack2.targetFps <= 60);
});

test('4. PairingCodeManager (single-use + 5-attempt lockout) and TicketManager (60s single-use)', () => {
  let now = 100_000;
  const pairing = new PairingCodeManager({
    ttlMs: 5 * 60_000,
    maxAttempts: 5,
    lockoutMs: 60_000,
    nowMs: () => now,
    initialCode: '654321',
  });

  // 4 wrong attempts -> 401
  for (let i = 0; i < 4; i++) {
    const res = pairing.exchange('000000', 'master-tok');
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
  }
  // 5th wrong attempt -> 429 lockout!
  const locked = pairing.exchange('111111', 'master-tok');
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 429);
  assert.equal(pairing.isLocked(), true);

  // Even the correct code is blocked during lockout
  const blockedCorrect = pairing.exchange('654321', 'master-tok');
  assert.equal(blockedCorrect.ok, false);
  assert.equal(blockedCorrect.status, 429);

  // After lockout expires, correct code works ONCE and is consumed atomically
  now += 61_000;
  const okRes = pairing.exchange('654321', 'master-tok');
  assert.equal(okRes.ok, true);
  if (okRes.ok) assert.equal(okRes.token, 'master-tok');

  const replayRes = pairing.exchange('654321', 'master-tok');
  assert.equal(replayRes.ok, false);
  assert.equal(replayRes.status, 401);

  // TicketManager: 60s single-use consumption + expiry
  const tickets = new TicketManager({ ttlMs: 60_000, nowMs: () => now });
  const t1 = tickets.issue();
  assert.equal(t1.expiresInSec, 60);
  assert.equal(tickets.consume(t1.ticket).ok, true);
  assert.equal(tickets.consume(t1.ticket).ok, false, 'Replayed ticket must fail');

  const t2 = tickets.issue();
  now += 61_000;
  assert.equal(tickets.consume(t2.ticket).ok, false, 'Expired ticket must fail');

  // GatewayAuthManager upgrade auth
  const auth = new GatewayAuthManager({ token: 'secret-master-token', tickets: { nowMs: () => now } });
  const issued = auth.tickets.issue();
  assert.equal(auth.authenticateUpgrade(undefined).ok, false);
  assert.equal(auth.authenticateUpgrade('bearer.wrong').ok, false);
  const firstUse = auth.authenticateUpgrade(`ticket.${issued.ticket}`);
  assert.equal(firstUse.ok, true);
  const secondUse = auth.authenticateUpgrade(`ticket.${issued.ticket}`);
  assert.equal(secondUse.ok, false, 'Ticket replay on WS upgrade must be rejected');
});

test('5. TargetPolicy blocks cloud metadata SSRF endpoints, obfuscated IPs, and enforces CIDRs', async () => {
  const policy = new TargetPolicy({
    allowCidrs: ['10.0.0.0/8', '192.168.1.0/24', 'fd12:3456::/32'],
    denyCidrs: ['10.0.0.99/32'],
    dnsLookup: async (host) => {
      if (host === 'rebind-imds.evil') return ['169.254.169.254'];
      if (host === 'rdp-prod.internal') return ['10.0.0.15'];
      return ['8.8.8.8'];
    },
  });

  // Unconditional cloud metadata blocks
  for (const metaHost of [
    '169.254.169.254',
    '169.254.170.2',
    'fd00:ec2::254',
    '::ffff:169.254.169.254',
    'metadata.google.internal',
    'metadata.goog',
  ]) {
    const r = await policy.validate(metaHost, 3389);
    assert.equal(r.ok, false, `${metaHost} must be blocked`);
    if (!r.ok) assert.equal(r.code, 'metadata_blocked');
  }

  // Obfuscated decimal IPv4 for 169.254.169.254
  const obf = await policy.validate('2852039166', 80);
  assert.equal(obf.ok, false);

  // DNS rebinding to IMDS
  const rebind = await policy.validate('rebind-imds.evil', 3389);
  assert.equal(rebind.ok, false);
  if (!rebind.ok) assert.equal(rebind.code, 'metadata_blocked');

  // Invalid ports
  assert.equal((await policy.validate('10.0.0.15', 0)).ok, false);
  assert.equal((await policy.validate('10.0.0.15', 65536)).ok, false);

  // Denied CIDR vs Allowed CIDR (IPv4 & IPv6)
  assert.equal((await policy.validate('10.0.0.99', 3389)).ok, false);
  assert.equal((await policy.validate('172.16.0.10', 3389)).ok, false);
  assert.equal((await policy.validate('10.0.0.15', 3389)).ok, true);
  assert.equal((await policy.validate('rdp-prod.internal', 3389)).ok, true);
  assert.equal((await policy.validate('fd12:3456::42', 22)).ok, true);
});

test('6. Full HTTP + WS Server: pairing, ticket replay 401, SSRF block, Observer vs Exclusive Lock, held-key release & abrupt disconnect cleanup', async () => {
  const receivedInputs: Jsr1InputEvent[] = [];
  let backendClosedCount = 0;
  let factoryCallCount = 0;
  let activeSink: BackendSink | null = null;

  const mockFactory: GatewaySessionFactory = async (params, sink) => {
    factoryCallCount += 1;
    activeSink = sink;
    const width = 128;
    const height = 128;
    const frame = new Uint8Array(width * height * 4);
    frame.fill(120);
    setTimeout(() => sink.onFrame(frame, width, height, true), 5);

    const backend: GatewayBackend = {
      protocol: params.protocol,
      width,
      height,
      sendInput(ev) {
        receivedInputs.push(ev);
      },
      async close() {
        backendClosedCount += 1;
      },
    };
    return backend;
  };

  const gw = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    allowDemoSession: true,
    auth: { pairing: { initialCode: '246810' } },
    sessionFactory: mockFactory,
  });

  const info = await gw.listen();
  try {
    // a. /healthz never leaks token or pairing code
    const healthRes = await fetch(`${info.url}/healthz`);
    assert.equal(healthRes.status, 200);
    const healthText = await healthRes.text();
    assert.equal(healthText.includes(gw.auth.getMasterTokenForCli()), false);
    assert.equal(healthText.includes('246810'), false);
    const healthJson = JSON.parse(healthText) as Record<string, unknown>;
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.version, '1.17.0');
    assert.equal(healthJson.protocol, 'JSR1');
    assert.equal(healthJson.pairingActive, true);

    // b. Unauthenticated WS upgrade -> HTTP 401!
    const unauthWs = await attemptWsUpgrade(info.host, info.port, '/ws');
    assert.equal(unauthWs.upgraded, false);
    if (!unauthWs.upgraded) assert.equal(unauthWs.statusCode, 401);

    // c. Exchange 6-digit pairing code -> get bearer token
    const pairRes = await fetch(`${info.url}/api/pair/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '246810' }),
    });
    assert.equal(pairRes.status, 200);
    const pairJson = (await pairRes.json()) as { ok: boolean; token: string };
    assert.equal(pairJson.ok, true);
    const token = pairJson.token;

    // d. Request single-use ticket with Bearer token
    const noAuthTicket = await fetch(`${info.url}/api/tickets`, { method: 'POST' });
    assert.equal(noAuthTicket.status, 401);

    const issueTicket = async (): Promise<string> => {
      const r = await fetch(`${info.url}/api/tickets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(r.status, 200);
      const j = (await r.json()) as { ok: boolean; ticket: string; expiresInSec: number };
      assert.equal(j.expiresInSec, 60);
      return j.ticket;
    };

    const ticket1 = await issueTicket();
    const ws1Up = await attemptWsUpgrade(info.host, info.port, '/ws', [`ticket.${ticket1}`]);
    assert.equal(ws1Up.upgraded, true);
    if (!ws1Up.upgraded) throw new Error('Expected WS upgrade');
    const client1 = ws1Up.client;
    assert.equal(client1.headers['sec-websocket-protocol'], `ticket.${ticket1}`);

    // e. Replaying ticket1 MUST fail with HTTP 401!
    const replayUp = await attemptWsUpgrade(info.host, info.port, '/ws', [`ticket.${ticket1}`]);
    assert.equal(replayUp.upgraded, false);
    if (!replayUp.upgraded) assert.equal(replayUp.statusCode, 401);

    // f. SSRF block over WS CONTROL_JSON open to 169.254.169.254
    client1.sendBinary(
      encodeControlJson({ type: 'open', protocol: 'rdp', host: '169.254.169.254', port: 3389 }),
    );
    const ssrfErr = await client1.waitFor(
      (m) => m.type === Jsr1MsgType.CONTROL_JSON && m.control.type === 'error',
    );
    assert.equal(ssrfErr.type, Jsr1MsgType.CONTROL_JSON);
    if (ssrfErr.type === Jsr1MsgType.CONTROL_JSON) {
      assert.equal(ssrfErr.control.code, 'ssrf_blocked');
    }
    assert.equal(factoryCallCount, 0, 'SSRF blocked target must never spawn backend');

    // g. Open valid multiplexed session as Controller
    client1.sendBinary(
      encodeControlJson({
        type: 'open',
        sessionId: 'sess-shared-1',
        protocol: 'rdp',
        host: '10.10.0.5',
        port: 3389,
      }),
    );
    const opened1 = await client1.waitFor(
      (m) => m.type === Jsr1MsgType.CONTROL_JSON && m.control.type === 'opened',
    );
    assert.equal(opened1.type, Jsr1MsgType.CONTROL_JSON);
    if (opened1.type === Jsr1MsgType.CONTROL_JSON) {
      assert.equal(opened1.control.hasControl, true);
      assert.equal(opened1.control.sessionId, 'sess-shared-1');
    }

    // Receive initial keyframe PNG tile and send FRAME_ACK
    const tile1 = await client1.waitFor((m) => m.type === Jsr1MsgType.FRAME_TILE);
    assert.equal(tile1.type, Jsr1MsgType.FRAME_TILE);
    if (tile1.type === Jsr1MsgType.FRAME_TILE) {
      client1.sendBinary(encodeFrameAck({ seq: tile1.tile.seq, viewerWaitUs: 1200 }));
    }

    // Controller holds Ctrl (29) + KeyA (30)
    client1.sendBinary(
      encodeInputEvent({ kind: Jsr1InputKind.KEY_DOWN, normX: 0, normY: 0, codeOrDelta: 29, flags: 0 }),
    );
    client1.sendBinary(
      encodeInputEvent({ kind: Jsr1InputKind.KEY_DOWN, normX: 0, normY: 0, codeOrDelta: 30, flags: 0 }),
    );

    // h. Client 2 joins same session in View-Only Observer mode
    const ticket2 = await issueTicket();
    const ws2Up = await attemptWsUpgrade(info.host, info.port, '/ws', [`ticket.${ticket2}`]);
    assert.equal(ws2Up.upgraded, true);
    if (!ws2Up.upgraded) throw new Error('Expected WS2 upgrade');
    const client2 = ws2Up.client;

    client2.sendBinary(
      encodeControlJson({ type: 'open', sessionId: 'sess-shared-1', viewOnly: true }),
    );
    const opened2 = await client2.waitFor(
      (m) => m.type === Jsr1MsgType.CONTROL_JSON && m.control.type === 'opened',
    );
    if (opened2.type === Jsr1MsgType.CONTROL_JSON) {
      assert.equal(opened2.control.viewOnly, true);
      assert.equal(opened2.control.hasControl, false);
      assert.equal(opened2.control.viewers, 2);
    }

    // Observer receives keyframe tile automatically
    const observerTile = await client2.waitFor((m) => m.type === Jsr1MsgType.FRAME_TILE);
    assert.equal(observerTile.type, Jsr1MsgType.FRAME_TILE);

    // Observer tries to inject input -> MUST BE IGNORED!
    client2.sendBinary(
      encodeInputEvent({ kind: Jsr1InputKind.UNICODE, normX: 0, normY: 0, codeOrDelta: 0, flags: 0, text: 'SHOULD_DROP' }),
    );
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      receivedInputs.some((i) => i.text === 'SHOULD_DROP'),
      false,
      'View-Only observer input must be dropped',
    );

    // i. Client 2 requests Exclusive Input Lock (`takeControl`) -> Client 1 held keys (29, 30) auto-released!
    client2.sendBinary(encodeControlJson({ type: 'takeControl' }));
    await client2.waitFor(
      (m) => m.type === Jsr1MsgType.CONTROL_JSON && m.control.type === 'controlState' && m.control.hasControl === true,
    );
    const releasedCodes = receivedInputs
      .filter((i) => i.kind === Jsr1InputKind.KEY_UP)
      .map((i) => i.codeOrDelta)
      .sort((a, b) => a - b);
    assert.deepEqual(releasedCodes, [29, 30], 'Taking control must auto-release prior controller held keys');

    // Now client2 holds key 57 (Space), then abruptly drops TCP socket -> key 57 auto-released!
    client2.sendBinary(
      encodeInputEvent({ kind: Jsr1InputKind.KEY_DOWN, normX: 0, normY: 0, codeOrDelta: 57, flags: 0 }),
    );
    await new Promise((r) => setTimeout(r, 30));
    client2.destroy();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(
      receivedInputs.some((i) => i.kind === Jsr1InputKind.KEY_UP && i.codeOrDelta === 57),
      true,
      'Abrupt controller disconnect must release held keys',
    );
    assert.equal(gw.activeSessionCount(), 1, 'Session stays alive while viewer 1 remains');
    assert.equal(backendClosedCount, 0);

    // j. Last viewer (client1) abruptly disconnects -> backend immediately closes (0 orphans!)
    assert.ok(activeSink);
    client1.destroy();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(backendClosedCount, 1, 'Abrupt last-viewer disconnect must tear down backend immediately');
    assert.equal(gw.activeSessionCount(), 0);
  } finally {
    await gw.close();
  }
});

test('7. Built-in --demo-session live desktop tiles, 2FA Unicode auto-type, SSH echo & SFTP + static UI serving', async () => {
  const gw = createGatewayServer({
    host: '127.0.0.1',
    port: 0,
    allowDemoSession: true,
    serveUi: true,
  });
  const info = await gw.listen();

  try {
    // Verify static UI & sibling /assets/* serving works when serveUi is enabled
    const uiRes = await fetch(`${info.url}/`);
    assert.equal(uiRes.status, 200);
    const uiHtml = await uiRes.text();
    assert.ok(uiHtml.includes('<!DOCTYPE html>') || uiHtml.includes('<html'));

    const oauthLogoRes = await fetch(`${info.url}/assets/jaladesk-oauth-logo-120.png`);
    assert.equal(oauthLogoRes.status, 200);
    assert.equal(oauthLogoRes.headers.get('content-type'), 'image/png');
    await oauthLogoRes.arrayBuffer();

    const mainLogoRes = await fetch(`${info.url}/assets/jaladesk-logo.png`);
    assert.equal(mainLogoRes.status, 200);
    assert.equal(mainLogoRes.headers.get('content-type'), 'image/png');
    await mainLogoRes.arrayBuffer();

    // Path traversal attempts under /assets/ must be rejected (never 200)
    const trav1 = await fetch(`${info.url}/assets/../package.json`);
    assert.ok(trav1.status === 403 || trav1.status === 404, `Expected 403/404 for traversal, got ${trav1.status}`);
    await trav1.text();

    const trav2 = await fetch(`${info.url}/assets/..%2f..%2fpackage.json`);
    assert.equal(trav2.status, 403);
    await trav2.text();

    // Authenticate with ticket
    const ticketRes = await fetch(`${info.url}/api/tickets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.auth.getMasterTokenForCli()}` },
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    const wsUp = await attemptWsUpgrade(info.host, info.port, '/ws', [`ticket.${ticket}`]);
    assert.equal(wsUp.upgraded, true);
    if (!wsUp.upgraded) throw new Error('Expected demo WS upgrade');
    const client = wsUp.client;

    client.sendBinary(encodeControlJson({ type: 'open', protocol: 'demo', width: 640, height: 360 }));
    const opened = await client.waitFor(
      (m) => m.type === Jsr1MsgType.CONTROL_JSON && m.control.type === 'opened',
    );
    assert.equal(opened.type, Jsr1MsgType.CONTROL_JSON);

    // Must receive valid decodable PNG tile from demo desktop
    const tileMsg = await client.waitFor((m) => m.type === Jsr1MsgType.FRAME_TILE);
    assert.equal(tileMsg.type, Jsr1MsgType.FRAME_TILE);
    if (tileMsg.type === Jsr1MsgType.FRAME_TILE) {
      const decodedPng = decodeTestPngRgba(Buffer.from(tileMsg.tile.payload));
      assert.equal(decodedPng.width, 640);
      assert.equal(decodedPng.height, 360);
      client.sendBinary(encodeFrameAck({ seq: tileMsg.tile.seq, viewerWaitUs: 900 }));
    }

    // Send 2FA Unicode input -> triggers fresh dirty-rect tile
    const prevCount = client.messages.filter((m) => m.type === Jsr1MsgType.FRAME_TILE).length;
    client.sendBinary(
      encodeInputEvent({ kind: Jsr1InputKind.UNICODE, normX: 0, normY: 0, codeOrDelta: 0, flags: 0, text: '123456' }),
    );
    await client.waitFor(
      () => client.messages.filter((m) => m.type === Jsr1MsgType.FRAME_TILE).length > prevCount,
    );

    // Interactive SSH demo echo
    client.sendBinary(encodeControlJson({ type: 'sshData', data: 'whoami\n' }));
    const sshOut = await client.waitFor(
      (m) =>
        m.type === Jsr1MsgType.CONTROL_JSON &&
        m.control.type === 'sshData' &&
        String(m.control.data).includes('jaladesk-demo'),
    );
    assert.equal(sshOut.type, Jsr1MsgType.CONTROL_JSON);

    // Interactive SFTP demo list + read
    client.sendBinary(encodeControlJson({ type: 'sftpReq', reqId: 'r1', action: 'list', path: '/' }));
    const sftpList = await client.waitFor(
      (m) => m.type === Jsr1MsgType.CONTROL_JSON && m.control.type === 'sftpRes' && m.control.reqId === 'r1',
    );
    assert.equal(sftpList.type, Jsr1MsgType.CONTROL_JSON);
    if (sftpList.type === Jsr1MsgType.CONTROL_JSON) {
      assert.equal(sftpList.control.ok, true);
      assert.ok(Array.isArray(sftpList.control.entries));
    }

    client.close();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(gw.activeSessionCount(), 0);
  } finally {
    await gw.close();
  }
});
