/**
 * JalaDesk Self-Hosted Web Gateway Server (`Tier 2`)
 *
 * Bridges browser WebSocket (`JSR1`) sessions to native FreeRDP 3 (`rdp-bridge`),
 * RFB/VNC (`protocol-engine`), SSH PTY, streaming SFTP, or synthetic `--demo-session`
 * with zero external npm runtime dependencies.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProfiledOwner } from '../protocols/rdp/profiled-owner.js';
import type { Session as RdpSession } from '../protocols/rdp/owner.js';
import type { Input as RdpInput, RdpTarget } from '../protocols/rdp/wire.js';
import {
  closeVncSession,
  openVncSession,
  readVncFrame,
  sendVncInput,
} from '../desktop/protocol-engine.js';

import { GatewayAuthManager, type GatewayAuthOptions } from './auth-tickets.js';
import { DirtyRectFrameEncoder } from './frame-encoder.js';
import { TargetPolicy, type TargetPolicyOptions } from './target-policy.js';
import {
  ClosedLoopCongestionController,
  Jsr1InputKind,
  Jsr1MsgType,
  decodeJsr1Message,
  encodeControlJson,
  encodeFrameTile,
  nowMicros,
  type Jsr1ControlMessage,
  type Jsr1InputEvent,
} from './wire-protocol.js';
import { PureWsConnection, acceptWebSocketUpgrade, rejectUpgrade } from './ws-server.js';

export const GATEWAY_VERSION = '1.17.0';
export const GATEWAY_PROTOCOL = 'JSR1';

export type GatewayProtocol = 'rdp' | 'vnc' | 'ssh' | 'sftp' | 'demo';

export interface OpenSessionParams {
  sessionId?: string;
  protocol: GatewayProtocol;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  domain?: string;
  certificateSha256?: string;
  jumpHost?: string;
  jumpPassword?: string;
  privateKey?: string;
  width?: number;
  height?: number;
  cols?: number;
  rows?: number;
  viewOnly?: boolean;
}

export interface BackendSink {
  onFrame(rgba: Uint8Array, width: number, height: number, forceKeyframe?: boolean): void;
  onSshData(data: string): void;
  onState(state: 'connected' | 'closed' | 'failed', reason?: string): void;
  onError(code: string, message: string): void;
}

export interface SftpResponsePayload {
  ok: boolean;
  entries?: Array<{ name: string; type: 'file' | 'dir'; size: number; mtime: string }>;
  dataBase64?: string;
  totalBytes?: number;
  offset?: number;
  eof?: boolean;
  error?: string;
}

export interface SftpRequestPayload {
  reqId: string;
  action: 'list' | 'read' | 'write' | 'mkdir' | 'delete';
  path: string;
  dataBase64?: string;
  offset?: number;
  length?: number;
}

export interface GatewayBackend {
  readonly protocol: GatewayProtocol;
  readonly width: number;
  readonly height: number;
  sendInput(event: Jsr1InputEvent): void;
  resize?(width: number, height: number): void;
  sendSshData?(data: string): void;
  resizeSsh?(cols: number, rows: number): void;
  handleSftp?(req: SftpRequestPayload): Promise<SftpResponsePayload>;
  close(): Promise<void>;
}

export type GatewaySessionFactory = (
  params: OpenSessionParams,
  sink: BackendSink,
  context: { rdpHelperPath: string; allowDemoSession: boolean },
) => Promise<GatewayBackend>;

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  auth?: GatewayAuthOptions;
  targetPolicy?: TargetPolicyOptions;
  corsOrigins?: readonly string[];
  serveUi?: boolean;
  uiDir?: string;
  allowDemoSession?: boolean;
  rdpHelperPath?: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  sessionFactory?: GatewaySessionFactory;
  maxInFlightFrames?: number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Minimal 5x7 uppercase/digit bitmap font for synthetic demo desktop rendering
const FONT_5X7: Record<string, readonly number[]> = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x0e, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0e, 0x11, 0x10, 0x0e, 0x01, 0x11, 0x0e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  ':': [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x00],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x06],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '>': [0x10, 0x08, 0x04, 0x02, 0x04, 0x08, 0x10],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

function fillRectRgba(
  rgba: Uint8Array,
  fullW: number,
  fullH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(fullW, Math.floor(x + w));
  const y1 = Math.min(fullH, Math.floor(y + h));
  for (let py = y0; py < y1; py++) {
    let idx = (py * fullW + x0) * 4;
    for (let px = x0; px < x1; px++) {
      rgba[idx++] = r;
      rgba[idx++] = g;
      rgba[idx++] = b;
      rgba[idx++] = a;
    }
  }
}

function drawTextRgba(
  rgba: Uint8Array,
  fullW: number,
  fullH: number,
  x: number,
  y: number,
  text: string,
  scale: number,
  r: number,
  g: number,
  b: number,
): void {
  const upper = text.toUpperCase();
  let cx = x;
  for (const ch of upper) {
    const glyph = FONT_5X7[ch] ?? FONT_5X7[' ']!;
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row]!;
      for (let col = 0; col < 5; col++) {
        if ((bits & (1 << (4 - col))) !== 0) {
          fillRectRgba(rgba, fullW, fullH, cx + col * scale, y + row * scale, scale, scale, r, g, b);
        }
      }
    }
    cx += 6 * scale;
  }
}

// Basic US ASCII to RDP AT Set-1 scanCode table for Unicode auto-type over RDP
const ASCII_TO_RDP_SCANCODE: Record<string, { scanCode: number; shift?: boolean }> = {
  '1': { scanCode: 2 },
  '2': { scanCode: 3 },
  '3': { scanCode: 4 },
  '4': { scanCode: 5 },
  '5': { scanCode: 6 },
  '6': { scanCode: 7 },
  '7': { scanCode: 8 },
  '8': { scanCode: 9 },
  '9': { scanCode: 10 },
  '0': { scanCode: 11 },
  '-': { scanCode: 12 },
  '=': { scanCode: 13 },
  '\n': { scanCode: 28 },
  '\t': { scanCode: 15 },
  ' ': { scanCode: 57 },
  a: { scanCode: 30 },
  b: { scanCode: 48 },
  c: { scanCode: 46 },
  d: { scanCode: 32 },
  e: { scanCode: 18 },
  f: { scanCode: 33 },
  g: { scanCode: 34 },
  h: { scanCode: 35 },
  i: { scanCode: 23 },
  j: { scanCode: 36 },
  k: { scanCode: 37 },
  l: { scanCode: 38 },
  m: { scanCode: 50 },
  n: { scanCode: 49 },
  o: { scanCode: 24 },
  p: { scanCode: 25 },
  q: { scanCode: 16 },
  r: { scanCode: 19 },
  s: { scanCode: 31 },
  t: { scanCode: 20 },
  u: { scanCode: 22 },
  v: { scanCode: 47 },
  w: { scanCode: 17 },
  x: { scanCode: 45 },
  y: { scanCode: 21 },
  z: { scanCode: 44 },
  '.': { scanCode: 52 },
  ',': { scanCode: 51 },
  '/': { scanCode: 53 },
  ';': { scanCode: 39 },
  ':': { scanCode: 39, shift: true },
  '!': { scanCode: 2, shift: true },
  '@': { scanCode: 3, shift: true },
  '#': { scanCode: 4, shift: true },
  $: { scanCode: 5, shift: true },
  '%': { scanCode: 6, shift: true },
  '^': { scanCode: 7, shift: true },
  '&': { scanCode: 8, shift: true },
  '*': { scanCode: 9, shift: true },
  '(': { scanCode: 10, shift: true },
  ')': { scanCode: 11, shift: true },
  _: { scanCode: 12, shift: true },
  '+': { scanCode: 13, shift: true },
};

/**
 * Built-in interactive synthetic desktop + SSH/SFTP backend (`--demo-session`)
 * for instant browser E2E testing without needing an external Windows RDP host.
 */
export class DemoGatewayBackend implements GatewayBackend {
  readonly protocol: GatewayProtocol = 'demo';
  width: number;
  height: number;

  private readonly sink: BackendSink;
  private rgba: Uint8Array;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private tick = 0;
  private cursorX: number;
  private cursorY: number;
  private lastClickX = -1;
  private lastClickY = -1;
  private typedBuffer = '';
  private sshLineBuffer = '';
  private readonly demoFiles = new Map<string, Buffer>([
    ['/README.txt', Buffer.from('JalaDesk Web Gateway Demo Filesystem\nProtocol: JSR1 Binary WebSocket\n', 'utf8')],
    ['/server-status.log', Buffer.from('status=healthy\nprotocol=JSR1\nfreeRDP=ready\n', 'utf8')],
  ]);

  constructor(width: number, height: number, sink: BackendSink) {
    this.width = Math.max(320, Math.min(1920, Math.floor(width || 1280)));
    this.height = Math.max(240, Math.min(1080, Math.floor(height || 720)));
    this.sink = sink;
    this.rgba = new Uint8Array(this.width * this.height * 4);
    this.cursorX = Math.floor(this.width / 2);
    this.cursorY = Math.floor(this.height / 2);

    this.renderBaseDesktop();
    this.renderDynamicRegion();
    this.sink.onState('connected');
    this.sink.onFrame(this.rgba, this.width, this.height, true);
    this.sink.onSshData('JalaDesk Demo Shell ready (type "help", "whoami", "uname -a", or "ls")\r\n$ ');

    this.timer = setInterval(() => {
      if (this.closed) return;
      this.tick += 1;
      this.renderDynamicRegion();
      this.sink.onFrame(this.rgba, this.width, this.height, false);
    }, 150);
    this.timer.unref();
  }

  private renderBaseDesktop(): void {
    const w = this.width;
    const h = this.height;
    // Deep slate desktop backdrop
    fillRectRgba(this.rgba, w, h, 0, 0, w, h, 15, 23, 42);
    // Subtle top taskbar
    fillRectRgba(this.rgba, w, h, 0, 0, w, 40, 30, 41, 59);
    fillRectRgba(this.rgba, w, h, 0, 39, w, 1, 51, 65, 85);
    drawTextRgba(this.rgba, w, h, 18, 12, 'JALADESK GATEWAY DEMO', 2, 226, 232, 240);

    // Main terminal / workspace window card
    const winX = Math.max(24, Math.floor(w * 0.08));
    const winY = 72;
    const winW = Math.min(w - winX * 2, 760);
    const winH = Math.min(h - winY - 40, 440);
    fillRectRgba(this.rgba, w, h, winX, winY, winW, winH, 17, 24, 39);
    fillRectRgba(this.rgba, w, h, winX, winY, winW, 34, 31, 41, 55);
    // Window border
    fillRectRgba(this.rgba, w, h, winX, winY, winW, 1, 71, 85, 105);
    fillRectRgba(this.rgba, w, h, winX, winY + winH - 1, winW, 1, 71, 85, 105);
    fillRectRgba(this.rgba, w, h, winX, winY, 1, winH, 71, 85, 105);
    fillRectRgba(this.rgba, w, h, winX + winW - 1, winY, 1, winH, 71, 85, 105);
    // Traffic dots
    fillRectRgba(this.rgba, w, h, winX + 14, winY + 12, 10, 10, 239, 68, 68);
    fillRectRgba(this.rgba, w, h, winX + 32, winY + 12, 10, 10, 245, 158, 11);
    fillRectRgba(this.rgba, w, h, winX + 50, winY + 12, 10, 10, 16, 185, 129);
    drawTextRgba(this.rgba, w, h, winX + 76, winY + 10, 'JSR1 LIVE DESKTOP STREAM', 2, 148, 163, 184);
    drawTextRgba(this.rgba, w, h, winX + 24, winY + 58, 'STATUS: CONNECTED', 2, 52, 211, 153);
    drawTextRgba(this.rgba, w, h, winX + 24, winY + 94, 'INPUT / 2FA AUTO-TYPE:', 2, 148, 163, 184);
  }

  private renderDynamicRegion(): void {
    const w = this.width;
    const h = this.height;
    const winX = Math.max(24, Math.floor(w * 0.08));
    const winY = 72;
    const winW = Math.min(w - winX * 2, 760);

    // Small animated heartbeat strip (dirty-rect optimized: only ~240x32 changes per tick)
    const pulseX = winX + 24;
    const pulseY = winY + 196;
    const pulseW = Math.min(280, winW - 48);
    fillRectRgba(this.rgba, w, h, pulseX, pulseY, pulseW, 28, 30, 41, 59);
    const barPos = (this.tick * 12) % Math.max(24, pulseW - 36);
    fillRectRgba(this.rgba, w, h, pulseX + barPos, pulseY + 4, 32, 20, 56, 189, 248);

    // Input / 2FA typed box
    const boxX = winX + 24;
    const boxY = winY + 124;
    const boxW = Math.min(540, winW - 48);
    fillRectRgba(this.rgba, w, h, boxX, boxY, boxW, 44, 15, 23, 42);
    fillRectRgba(this.rgba, w, h, boxX, boxY, boxW, 1, 56, 189, 248);
    fillRectRgba(this.rgba, w, h, boxX, boxY + 43, boxW, 1, 56, 189, 248);
    const visibleText = (this.typedBuffer || 'READY').slice(-26);
    drawTextRgba(this.rgba, w, h, boxX + 12, boxY + 12, `> ${visibleText}`, 2, 248, 250, 252);

    // Click marker if user clicked
    if (this.lastClickX >= 0 && this.lastClickY >= 0) {
      fillRectRgba(this.rgba, w, h, this.lastClickX - 4, this.lastClickY - 4, 9, 9, 16, 185, 129);
    }

    // Telemetry tick counter in top bar right
    const counterX = Math.max(260, w - 190);
    fillRectRgba(this.rgba, w, h, counterX, 8, 170, 24, 30, 41, 59);
    drawTextRgba(this.rgba, w, h, counterX + 6, 12, `TICK:${String(this.tick).padStart(5, '0')}`, 2, 56, 189, 248);
  }

  sendInput(event: Jsr1InputEvent): void {
    if (this.closed) return;
    const px = Math.round((event.normX / 65535) * (this.width - 1));
    const py = Math.round((event.normY / 65535) * (this.height - 1));
    if (event.kind === Jsr1InputKind.MOVE) {
      this.cursorX = px;
      this.cursorY = py;
    } else if (event.kind === Jsr1InputKind.DOWN) {
      this.cursorX = px;
      this.cursorY = py;
      this.lastClickX = px;
      this.lastClickY = py;
    } else if (event.kind === Jsr1InputKind.UNICODE && event.text) {
      this.typedBuffer = (this.typedBuffer + event.text).slice(-64);
    } else if (event.kind === Jsr1InputKind.KEY_DOWN) {
      if (event.codeOrDelta === 8 || event.codeOrDelta === 14) {
        this.typedBuffer = this.typedBuffer.slice(0, -1);
      } else if (event.codeOrDelta === 13 || event.codeOrDelta === 28) {
        this.typedBuffer = '';
      }
    }
    this.renderDynamicRegion();
    this.sink.onFrame(this.rgba, this.width, this.height, false);
  }

  resize(width: number, height: number): void {
    if (this.closed) return;
    const nextW = Math.max(320, Math.min(1920, Math.floor(width)));
    const nextH = Math.max(240, Math.min(1080, Math.floor(height)));
    if (nextW === this.width && nextH === this.height) return;
    this.width = nextW;
    this.height = nextH;
    this.rgba = new Uint8Array(this.width * this.height * 4);
    this.renderBaseDesktop();
    this.renderDynamicRegion();
    this.sink.onFrame(this.rgba, this.width, this.height, true);
  }

  sendSshData(data: string): void {
    if (this.closed) return;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const cmd = this.sshLineBuffer.trim();
        this.sshLineBuffer = '';
        let out = '\r\n';
        if (cmd === 'whoami') out += 'jaladesk-demo\r\n';
        else if (cmd === 'uname -a') out += 'Linux jaladesk-gateway 6.8.0-demo x86_64 GNU/Linux\r\n';
        else if (cmd === 'ls') out += [...this.demoFiles.keys()].map((k) => k.slice(1)).join('  ') + '\r\n';
        else if (cmd === 'help') out += 'Commands: help, whoami, uname -a, ls, echo <text>\r\n';
        else if (cmd.startsWith('echo ')) out += `${cmd.slice(5)}\r\n`;
        else if (cmd.length > 0) out += `demo: executed "${cmd}"\r\n`;
        this.sink.onSshData(`${out}$ `);
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.sshLineBuffer.length > 0) {
          this.sshLineBuffer = this.sshLineBuffer.slice(0, -1);
          this.sink.onSshData('\b \b');
        }
      } else {
        this.sshLineBuffer += ch;
        this.sink.onSshData(ch);
      }
    }
  }

  async handleSftp(req: SftpRequestPayload): Promise<SftpResponsePayload> {
    const cleanPath = req.path.startsWith('/') ? req.path : `/${req.path}`;
    if (req.action === 'list') {
      const entries = [...this.demoFiles.entries()].map(([p, buf]) => ({
        name: p.replace(/^\//, ''),
        type: 'file' as const,
        size: buf.byteLength,
        mtime: new Date().toISOString(),
      }));
      return { ok: true, entries };
    }
    if (req.action === 'read') {
      const content = this.demoFiles.get(cleanPath);
      if (!content) return { ok: false, error: `File not found: ${cleanPath}` };
      const offset = Math.max(0, Math.floor(req.offset ?? 0));
      const length = Math.max(1, Math.min(1024 * 1024, Math.floor(req.length ?? content.byteLength)));
      const slice = content.subarray(offset, offset + length);
      return {
        ok: true,
        dataBase64: slice.toString('base64'),
        totalBytes: content.byteLength,
        offset,
        eof: offset + slice.byteLength >= content.byteLength,
      };
    }
    if (req.action === 'write') {
      const chunk = Buffer.from(req.dataBase64 ?? '', 'base64');
      const offset = Math.max(0, Math.floor(req.offset ?? 0));
      const existing = offset > 0 ? (this.demoFiles.get(cleanPath) ?? Buffer.alloc(0)) : Buffer.alloc(0);
      const next = offset > 0 ? Buffer.concat([existing.subarray(0, offset), chunk]) : chunk;
      this.demoFiles.set(cleanPath, next);
      return { ok: true, totalBytes: next.byteLength };
    }
    if (req.action === 'delete') {
      this.demoFiles.delete(cleanPath);
      return { ok: true };
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

class RdpGatewayBackend implements GatewayBackend {
  readonly protocol: GatewayProtocol = 'rdp';
  width: number;
  height: number;

  private session: RdpSession | null = null;
  private profileRoot: string;
  private pointerButtons = 0;
  private closed = false;

  private constructor(width: number, height: number, profileRoot: string) {
    this.width = width;
    this.height = height;
    this.profileRoot = profileRoot;
  }

  static async open(
    params: OpenSessionParams,
    sink: BackendSink,
    helperPath: string,
  ): Promise<RdpGatewayBackend> {
    if (!existsSync(helperPath)) {
      throw new Error(`Native RDP bridge binary not found at ${helperPath}`);
    }
    const width = Math.max(200, Math.min(4096, Math.floor(params.width ?? 1280)));
    const height = Math.max(200, Math.min(2048, Math.floor(params.height ?? 720)));
    const profileRoot = await mkdtemp(join(tmpdir(), 'jaladesk-gw-rdp-'));
    const backend = new RdpGatewayBackend(width, height, profileRoot);

    const owner = createProfiledOwner({ root: profileRoot, helper: helperPath });
    const target: RdpTarget = {
      host: params.host ?? '',
      port: params.port ?? 3389,
      username: params.username ?? 'Administrator',
      width,
      height,
      ...(params.certificateSha256 ? { certificateSha256: params.certificateSha256 } : {}),
    };

    try {
      backend.session = await owner.open(
        target,
        { password: params.password ?? '', domain: params.domain ?? '' },
        {
          frame(frame) {
            backend.width = frame.width;
            backend.height = frame.height;
            sink.onFrame(frame.rgba, frame.width, frame.height, false);
          },
          state(state, reason) {
            if (state === 'connected' || state === 'closed' || state === 'failed') {
              sink.onState(state, reason);
            }
          },
        },
      );
      return backend;
    } catch (err) {
      await rm(profileRoot, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  private safeSend(input: RdpInput): void {
    if (this.closed || !this.session) return;
    try {
      this.session.send(input);
    } catch {
      // Ignore invalid input edge cases
    }
  }

  sendInput(event: Jsr1InputEvent): void {
    if (this.closed || !this.session) return;
    const x = Math.max(0, Math.min(this.width - 1, Math.round((event.normX / 65535) * (this.width - 1))));
    const y = Math.max(0, Math.min(this.height - 1, Math.round((event.normY / 65535) * (this.height - 1))));

    switch (event.kind) {
      case Jsr1InputKind.MOVE:
        this.safeSend({ type: 'pointer', x, y, buttons: this.pointerButtons });
        return;
      case Jsr1InputKind.DOWN: {
        const bit = event.codeOrDelta === 2 ? 2 : event.codeOrDelta === 1 ? 4 : 1;
        this.pointerButtons = (this.pointerButtons | bit) & 7;
        this.safeSend({ type: 'pointer', x, y, buttons: this.pointerButtons });
        return;
      }
      case Jsr1InputKind.UP: {
        const bit = event.codeOrDelta === 2 ? 2 : event.codeOrDelta === 1 ? 4 : 1;
        this.pointerButtons = (this.pointerButtons & ~bit) & 7;
        this.safeSend({ type: 'pointer', x, y, buttons: this.pointerButtons });
        return;
      }
      case Jsr1InputKind.WHEEL: {
        const delta = Math.max(-4800, Math.min(4800, event.codeOrDelta || 120));
        if (delta !== 0) {
          this.safeSend({ type: (event.flags & 1) !== 0 ? 'hwheel' : 'wheel', x, y, delta });
        }
        return;
      }
      case Jsr1InputKind.KEY_DOWN:
      case Jsr1InputKind.KEY_UP: {
        const scanCode = event.codeOrDelta;
        if (scanCode >= 1 && scanCode <= 511) {
          this.safeSend({ type: 'key', scanCode, down: event.kind === Jsr1InputKind.KEY_DOWN });
        }
        return;
      }
      case Jsr1InputKind.UNICODE: {
        if (!event.text) return;
        for (const ch of event.text) {
          const isUpper = ch >= 'A' && ch <= 'Z';
          const mapped = ASCII_TO_RDP_SCANCODE[isUpper ? ch.toLowerCase() : ch];
          if (!mapped) continue;
          const needShift = Boolean(mapped.shift || isUpper);
          if (needShift) this.safeSend({ type: 'key', scanCode: 42, down: true });
          this.safeSend({ type: 'key', scanCode: mapped.scanCode, down: true });
          this.safeSend({ type: 'key', scanCode: mapped.scanCode, down: false });
          if (needShift) this.safeSend({ type: 'key', scanCode: 42, down: false });
        }
        return;
      }
    }
  }

  resize(width: number, height: number): void {
    const w = Math.max(200, Math.min(8192, Math.floor(width)));
    const h = Math.max(200, Math.min(8192, Math.floor(height)));
    this.safeSend({ type: 'resize', width: w - (w % 2), height: h });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.session?.close();
    } finally {
      this.session = null;
      await rm(this.profileRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

class VncGatewayBackend implements GatewayBackend {
  readonly protocol: GatewayProtocol = 'vnc';
  width: number;
  height: number;

  private readonly vncSessionId: string;
  private readonly sink: BackendSink;
  private closed = false;
  private lastSeq = 0;
  private buttonMask = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(sessionId: string, width: number, height: number, sink: BackendSink) {
    this.vncSessionId = sessionId;
    this.width = width;
    this.height = height;
    this.sink = sink;
    this.schedulePoll();
  }

  static async open(params: OpenSessionParams, sink: BackendSink): Promise<VncGatewayBackend> {
    const opened = await openVncSession({
      host: params.host,
      port: params.port ?? 5900,
      username: params.username ?? '',
      password: params.password ?? '',
      jumpHost: params.jumpHost ?? '',
      jumpPassword: params.jumpPassword ?? '',
    });
    if (!opened.ok || !opened.sessionId) {
      throw new Error(opened.error || 'Failed to open VNC session');
    }
    const backend = new VncGatewayBackend(opened.sessionId, opened.width || 1280, opened.height || 720, sink);
    sink.onState('connected');
    return backend;
  }

  private schedulePoll(): void {
    if (this.closed) return;
    this.pollTimer = setTimeout(async () => {
      if (this.closed) return;
      try {
        const frame = await readVncFrame({
          sessionId: this.vncSessionId,
          sinceSeq: this.lastSeq,
          waitMs: 80,
        });
        if (this.closed) return;
        if (!frame.ok || frame.closed) {
          this.closed = true;
          this.sink.onState(frame.error ? 'failed' : 'closed', frame.error);
          return;
        }
        if (frame.rgbaBase64 && frame.seq > this.lastSeq) {
          this.lastSeq = frame.seq;
          this.width = frame.width;
          this.height = frame.height;
          const rgba = Buffer.from(frame.rgbaBase64, 'base64');
          this.sink.onFrame(rgba, frame.width, frame.height, false);
        }
      } catch {
        // Retry until closed
      }
      this.schedulePoll();
    }, 25);
    this.pollTimer.unref();
  }

  sendInput(event: Jsr1InputEvent): void {
    if (this.closed) return;
    const x = Math.round((event.normX / 65535) * Math.max(0, this.width - 1));
    const y = Math.round((event.normY / 65535) * Math.max(0, this.height - 1));
    switch (event.kind) {
      case Jsr1InputKind.MOVE:
        sendVncInput({ sessionId: this.vncSessionId, kind: 'pointer', x, y, buttonMask: this.buttonMask });
        return;
      case Jsr1InputKind.DOWN: {
        const bit = event.codeOrDelta === 2 ? 4 : event.codeOrDelta === 1 ? 2 : 1;
        this.buttonMask = (this.buttonMask | bit) & 0xff;
        sendVncInput({ sessionId: this.vncSessionId, kind: 'pointer', x, y, buttonMask: this.buttonMask });
        return;
      }
      case Jsr1InputKind.UP: {
        const bit = event.codeOrDelta === 2 ? 4 : event.codeOrDelta === 1 ? 2 : 1;
        this.buttonMask = (this.buttonMask & ~bit) & 0xff;
        sendVncInput({ sessionId: this.vncSessionId, kind: 'pointer', x, y, buttonMask: this.buttonMask });
        return;
      }
      case Jsr1InputKind.WHEEL: {
        const bit = event.codeOrDelta > 0 ? 8 : 16;
        sendVncInput({ sessionId: this.vncSessionId, kind: 'pointer', x, y, buttonMask: this.buttonMask | bit });
        sendVncInput({ sessionId: this.vncSessionId, kind: 'pointer', x, y, buttonMask: this.buttonMask });
        return;
      }
      case Jsr1InputKind.KEY_DOWN:
      case Jsr1InputKind.KEY_UP:
        sendVncInput({
          sessionId: this.vncSessionId,
          kind: 'key',
          keysym: event.codeOrDelta >>> 0,
          down: event.kind === Jsr1InputKind.KEY_DOWN,
        });
        return;
      case Jsr1InputKind.UNICODE:
        if (!event.text) return;
        for (const ch of event.text) {
          const cp = ch.codePointAt(0);
          if (!cp) continue;
          const keysym = cp <= 0xff ? cp : 0x01000000 | cp;
          sendVncInput({ sessionId: this.vncSessionId, kind: 'key', keysym, down: true });
          sendVncInput({ sessionId: this.vncSessionId, kind: 'key', keysym, down: false });
        }
        return;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    closeVncSession({ sessionId: this.vncSessionId });
  }
}

class SshGatewayBackend implements GatewayBackend {
  readonly protocol: GatewayProtocol;
  readonly width = 0;
  readonly height = 0;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private tempDir: string;
  private readonly sshBaseArgs: string[];
  private readonly sshEnv: NodeJS.ProcessEnv;
  private closed = false;

  private constructor(
    protocol: 'ssh' | 'sftp',
    tempDir: string,
    sshBaseArgs: string[],
    sshEnv: NodeJS.ProcessEnv,
    proc: ChildProcessWithoutNullStreams | null,
  ) {
    this.protocol = protocol;
    this.tempDir = tempDir;
    this.sshBaseArgs = sshBaseArgs;
    this.sshEnv = sshEnv;
    this.proc = proc;
  }

  static async open(params: OpenSessionParams, sink: BackendSink): Promise<SshGatewayBackend> {
    const tempDir = await mkdtemp(join(tmpdir(), 'jaladesk-gw-ssh-'));
    const host = params.host ?? '';
    const port = params.port ?? 22;
    const username = params.username || 'root';

    const baseArgs: string[] = [
      '-p',
      String(port),
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'StrictHostKeyChecking=accept-new',
    ];

    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };

    if (params.privateKey && params.privateKey.trim()) {
      const keyFile = join(tempDir, 'id_ephemeral');
      await writeFile(keyFile, `${params.privateKey.trim()}\n`, { mode: 0o600 });
      await chmod(keyFile, 0o600);
      baseArgs.push('-i', keyFile, '-o', 'IdentitiesOnly=yes');
    }

    if (params.password) {
      // Ephemeral 0600 SSH_ASKPASS helper — avoids exposing password in process CLI args
      const askpassFile = join(tempDir, 'askpass.sh');
      const secretFile = join(tempDir, 'secret');
      await writeFile(secretFile, params.password, { mode: 0o600 });
      await chmod(secretFile, 0o600);
      await writeFile(askpassFile, `#!/bin/sh\ncat "${secretFile}"\n`, { mode: 0o700 });
      await chmod(askpassFile, 0o700);
      env.SSH_ASKPASS = askpassFile;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = ':0';
    }

    const targetSpec = `${username}@${host}`;
    let proc: ChildProcessWithoutNullStreams | null = null;
    if (params.protocol === 'ssh') {
      const cols = Math.max(20, Math.min(400, Math.floor(params.cols ?? 100)));
      const rows = Math.max(8, Math.min(200, Math.floor(params.rows ?? 30)));
      env.COLUMNS = String(cols);
      env.LINES = String(rows);
      proc = spawn('ssh', ['-tt', ...baseArgs, targetSpec], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      proc.stdout.on('data', (chunk: Buffer) => sink.onSshData(chunk.toString('utf8')));
      proc.stderr.on('data', (chunk: Buffer) => sink.onSshData(chunk.toString('utf8')));
      proc.on('error', (err) => sink.onState('failed', err.message));
      proc.on('close', (code) => sink.onState('closed', `exit:${code ?? 0}`));
    }

    sink.onState('connected');
    return new SshGatewayBackend(params.protocol === 'sftp' ? 'sftp' : 'ssh', tempDir, [...baseArgs, targetSpec], env, proc);
  }

  sendInput(event: Jsr1InputEvent): void {
    if (event.kind === Jsr1InputKind.UNICODE && event.text) {
      this.sendSshData(event.text);
    }
  }

  sendSshData(data: string): void {
    if (this.closed || !this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(data);
  }

  resizeSsh(cols: number, rows: number): void {
    if (this.closed || !this.proc || !this.proc.stdin.writable) return;
    const c = Math.max(20, Math.min(400, Math.floor(cols)));
    const r = Math.max(8, Math.min(200, Math.floor(rows)));
    this.proc.stdin.write(`stty rows ${r} cols ${c}\n`);
  }

  async handleSftp(req: SftpRequestPayload): Promise<SftpResponsePayload> {
    if (this.closed) return { ok: false, error: 'Session closed' };
    const safePath = req.path.replace(/["'`$\n\r]/g, '');
    if (req.action === 'list') {
      const out = await this.execSftpBatch(`ls -la "${safePath || '.'}"\n`);
      if (!out.ok) return { ok: false, error: out.error };
      const entries: NonNullable<SftpResponsePayload['entries']> = [];
      for (const line of out.stdout.split('\n')) {
        const m = /^([d-])[rwxstST-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line.trim());
        if (!m) continue;
        const name = m[4]!.trim();
        if (name === '.' || name === '..') continue;
        entries.push({
          name,
          type: m[1] === 'd' ? 'dir' : 'file',
          size: Number(m[2]) || 0,
          mtime: m[3]!,
        });
      }
      return { ok: true, entries };
    }
    if (req.action === 'read') {
      // Chunked streaming read via `dd` over SSH (supports arbitrarily large files > 50 MB)
      const offset = Math.max(0, Math.floor(req.offset ?? 0));
      const length = Math.max(1, Math.min(512 * 1024, Math.floor(req.length ?? 262144)));
      const cmd = `dd if="${safePath}" bs=1 skip=${offset} count=${length} status=none`;
      const res = await this.execSshCommand(cmd);
      if (!res.ok) return { ok: false, error: res.error };
      return {
        ok: true,
        dataBase64: res.stdout.toString('base64'),
        offset,
        eof: res.stdout.byteLength < length,
      };
    }
    if (req.action === 'write') {
      const chunk = Buffer.from(req.dataBase64 ?? '', 'base64');
      const offset = Math.max(0, Math.floor(req.offset ?? 0));
      const op = offset > 0 ? '>>' : '>';
      const res = await this.execSshCommand(`cat ${op} "${safePath}"`, chunk);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, totalBytes: offset + chunk.byteLength };
    }
    if (req.action === 'mkdir') {
      const res = await this.execSftpBatch(`mkdir "${safePath}"\n`);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
    if (req.action === 'delete') {
      const res = await this.execSftpBatch(`rm "${safePath}"\n`);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
    return { ok: false, error: `Unsupported SFTP action: ${req.action}` };
  }

  private execSftpBatch(batch: string): Promise<{ ok: boolean; stdout: string; error?: string }> {
    const sftpArgs = [...this.sshBaseArgs];
    const pIdx = sftpArgs.indexOf('-p');
    if (pIdx >= 0) sftpArgs[pIdx] = '-P';
    return new Promise((resolveDone) => {
      const child = spawn('sftp', ['-b', '-', ...sftpArgs], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.sshEnv,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', (e) => resolveDone({ ok: false, stdout: '', error: e.message }));
      child.on('close', (code) => {
        if (code === 0) resolveDone({ ok: true, stdout: Buffer.concat(out).toString('utf8') });
        else resolveDone({ ok: false, stdout: '', error: Buffer.concat(err).toString('utf8').trim() || `sftp exit ${code}` });
      });
      child.stdin.end(batch);
    });
  }

  private execSshCommand(
    remoteCmd: string,
    stdinBytes?: Buffer,
  ): Promise<{ ok: boolean; stdout: Buffer; error?: string }> {
    return new Promise((resolveDone) => {
      const child = spawn('ssh', [...this.sshBaseArgs, remoteCmd], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.sshEnv,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', (e) => resolveDone({ ok: false, stdout: Buffer.alloc(0), error: e.message }));
      child.on('close', (code) => {
        if (code === 0) resolveDone({ ok: true, stdout: Buffer.concat(out) });
        else resolveDone({ ok: false, stdout: Buffer.alloc(0), error: Buffer.concat(err).toString('utf8').trim() || `ssh exit ${code}` });
      });
      if (stdinBytes) child.stdin.end(stdinBytes);
      else child.stdin.end();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && !proc.killed) {
      await new Promise<void>((resolveDone) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceKill);
          resolveDone();
        };
        const forceKill = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
          done();
        }, 500);
        forceKill.unref();
        proc.once('close', done);
        try {
          proc.kill('SIGTERM');
        } catch {
          done();
        }
      });
    }
    await rm(this.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const defaultSessionFactory: GatewaySessionFactory = async (params, sink, ctx) => {
  if (params.protocol === 'demo') {
    if (!ctx.allowDemoSession) {
      throw new Error('Demo session mode is disabled on this gateway (start with --demo-session)');
    }
    return new DemoGatewayBackend(params.width ?? 1280, params.height ?? 720, sink);
  }
  if (params.protocol === 'rdp') {
    return RdpGatewayBackend.open(params, sink, ctx.rdpHelperPath);
  }
  if (params.protocol === 'vnc') {
    return VncGatewayBackend.open(params, sink);
  }
  if (params.protocol === 'ssh' || params.protocol === 'sftp') {
    return SshGatewayBackend.open(params, sink);
  }
  throw new Error(`Unsupported protocol: ${String(params.protocol)}`);
};

interface ViewerAttachment {
  id: string;
  conn: PureWsConnection;
  sessionId: string | null;
  viewOnly: boolean;
  cc: ClosedLoopCongestionController;
  needsKeyframe: boolean;
  lastStatsSentMs: number;
}

interface MultiplexedSession {
  id: string;
  protocol: GatewayProtocol;
  backend: GatewayBackend;
  encoder: DirtyRectFrameEncoder;
  viewers: Map<string, ViewerAttachment>;
  controllerId: string | null;
  heldKeys: Set<number>;
  heldButtons: Set<number>;
  seq: number;
  lastFrame: { rgba: Uint8Array; width: number; height: number } | null;
  closing: boolean;
}

function isAllowedCorsOrigin(origin: string | undefined, allowedList: readonly string[]): string | null {
  if (!origin) return null;
  if (allowedList.includes('*')) return '*';
  if (allowedList.includes(origin)) return origin;
  // Always permit loopback dev origins by default unless explicitly restricted
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(origin)) {
    return origin;
  }
  return null;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('Invalid JSON payload'), { status: 400 });
  }
}

export interface GatewayServerHandle {
  readonly server: HttpServer | HttpsServer;
  readonly auth: GatewayAuthManager;
  readonly policy: TargetPolicy;
  readonly port: number;
  readonly host: string;
  readonly protocol: 'http' | 'https';
  readonly activeSessionCount: () => number;
  readonly activeClientCount: () => number;
  listen(): Promise<{ host: string; port: number; url: string; wsUrl: string }>;
  close(): Promise<void>;
}

export function createGatewayServer(options: GatewayServerOptions = {}): GatewayServerHandle {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 8443;
  const auth = new GatewayAuthManager(options.auth);
  const policy = new TargetPolicy(options.targetPolicy);
  const allowDemoSession = Boolean(options.allowDemoSession);
  const serveUi = Boolean(options.serveUi);
  const maxInFlightFrames = options.maxInFlightFrames ?? 3;
  const sessionFactory = options.sessionFactory ?? defaultSessionFactory;

  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const defaultAppRoot = resolve(moduleDir, '..', '..', '..');
  const uiDir = resolve(options.uiDir ?? join(defaultAppRoot, 'docs', 'app'));
  const assetsDir = resolve(uiDir, '..', 'assets');
  const rdpHelperPath =
    options.rdpHelperPath ??
    (existsSync(join(defaultAppRoot, 'native', 'bin', 'rdp-bridge'))
      ? join(defaultAppRoot, 'native', 'bin', 'rdp-bridge')
      : '/usr/local/bin/rdp-bridge');

  const corsOrigins = options.corsOrigins ?? [
    'https://ribato22.github.io',
    'http://127.0.0.1',
    'http://localhost',
  ];

  const sessions = new Map<string, MultiplexedSession>();
  const clients = new Map<string, ViewerAttachment>();

  const sendControl = (conn: PureWsConnection, msg: Jsr1ControlMessage): void => {
    conn.sendBinary(encodeControlJson(msg));
  };

  const broadcastControl = (session: MultiplexedSession, msg: Jsr1ControlMessage): void => {
    const packet = encodeControlJson(msg);
    for (const viewer of session.viewers.values()) {
      viewer.conn.sendBinary(packet);
    }
  };

  const broadcastControlState = (session: MultiplexedSession): void => {
    for (const viewer of session.viewers.values()) {
      sendControl(viewer.conn, {
        type: 'controlState',
        sessionId: session.id,
        controllerId: session.controllerId,
        hasControl: session.controllerId === viewer.id,
        viewOnly: session.controllerId !== viewer.id,
        viewers: session.viewers.size,
        heldKeysCount: session.heldKeys.size,
      });
    }
  };

  const releaseHeldInputs = (session: MultiplexedSession): void => {
    if (session.closing) return;
    for (const code of session.heldKeys) {
      try {
        session.backend.sendInput({
          kind: Jsr1InputKind.KEY_UP,
          normX: 0,
          normY: 0,
          codeOrDelta: code,
          flags: 0,
        });
      } catch {
        // Ignore backend error during release
      }
    }
    session.heldKeys.clear();

    for (const btn of session.heldButtons) {
      try {
        session.backend.sendInput({
          kind: Jsr1InputKind.UP,
          normX: 0,
          normY: 0,
          codeOrDelta: btn,
          flags: 0,
        });
      } catch {
        // Ignore backend error during release
      }
    }
    session.heldButtons.clear();
  };

  const closeSession = async (session: MultiplexedSession): Promise<void> => {
    if (session.closing) return;
    session.closing = true;
    sessions.delete(session.id);
    session.heldKeys.clear();
    session.heldButtons.clear();
    try {
      await session.backend.close();
    } catch {
      // Ensure cleanup completes
    }
  };

  const detachViewer = async (viewer: ViewerAttachment): Promise<void> => {
    if (!viewer.sessionId) return;
    const session = sessions.get(viewer.sessionId);
    viewer.sessionId = null;
    if (!session) return;

    const wasController = session.controllerId === viewer.id;
    session.viewers.delete(viewer.id);

    if (wasController) {
      releaseHeldInputs(session);
      session.controllerId = null;
    }

    if (session.viewers.size === 0) {
      await closeSession(session);
    } else {
      broadcastControlState(session);
    }
  };

  const deliverFrameToSession = (
    session: MultiplexedSession,
    rgba: Uint8Array,
    width: number,
    height: number,
    forceKeyframe = false,
  ): void => {
    if (session.closing || session.viewers.size === 0) return;

    // Store copy for newly joining observers
    const copy = new Uint8Array(width * height * 4);
    copy.set(rgba.subarray(0, copy.byteLength));
    session.lastFrame = { rgba: copy, width, height };

    // Determine if any viewer can accept a frame (closed-loop congestion gate)
    const eligibleViewers = [...session.viewers.values()].filter(
      (v) => v.conn.isOpen && !v.conn.hasBackpressure() && v.cc.canSend(),
    );
    if (eligibleViewers.length === 0) {
      return;
    }

    const anyNeedsKeyframe = forceKeyframe || eligibleViewers.some((v) => v.needsKeyframe);
    const tiles = session.encoder.encodeFrame(copy, width, height, { forceKeyframe: anyNeedsKeyframe });
    if (tiles.length === 0) {
      // Idle zero-frame pause: nothing changed on screen
      return;
    }

    const sentUs = nowMicros();
    for (const tile of tiles) {
      session.seq = (session.seq + 1) >>> 0;
      const seq = session.seq;
      const packet = encodeFrameTile({
        seq,
        sentUs,
        x: tile.x,
        y: tile.y,
        w: tile.w,
        h: tile.h,
        fullW: tile.fullW,
        fullH: tile.fullH,
        codec: tile.codec,
        flags: tile.flags,
        payload: tile.payload,
      });

      for (const viewer of eligibleViewers) {
        if (viewer.conn.sendBinary(packet)) {
          viewer.cc.onFrameSent(seq, sentUs);
          viewer.needsKeyframe = false;
        }
      }
    }
  };

  const handleOpenControl = async (viewer: ViewerAttachment, msg: Jsr1ControlMessage): Promise<void> => {
    await detachViewer(viewer);

    const requestedSessionId =
      typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0 ? msg.sessionId.trim() : '';
    const requestedViewOnly = Boolean(msg.viewOnly);

    // Join existing session as observer or controller
    if (requestedSessionId && sessions.has(requestedSessionId)) {
      const existing = sessions.get(requestedSessionId)!;
      viewer.sessionId = existing.id;
      viewer.needsKeyframe = true;
      existing.viewers.set(viewer.id, viewer);

      if (!requestedViewOnly && existing.controllerId === null) {
        existing.controllerId = viewer.id;
        viewer.viewOnly = false;
      } else {
        viewer.viewOnly = true;
      }

      sendControl(viewer.conn, {
        type: 'opened',
        sessionId: existing.id,
        protocol: existing.protocol,
        width: existing.backend.width,
        height: existing.backend.height,
        viewOnly: existing.controllerId !== viewer.id,
        hasControl: existing.controllerId === viewer.id,
        controllerId: existing.controllerId,
        viewers: existing.viewers.size,
      });
      broadcastControlState(existing);

      // Push immediate keyframe to new observer
      if (existing.lastFrame) {
        deliverFrameToSession(existing, existing.lastFrame.rgba, existing.lastFrame.width, existing.lastFrame.height, true);
      }
      return;
    }

    const rawProto = String(msg.protocol ?? 'rdp').toLowerCase();
    if (!['rdp', 'vnc', 'ssh', 'sftp', 'demo'].includes(rawProto)) {
      sendControl(viewer.conn, { type: 'error', code: 'invalid_protocol', message: `Unsupported protocol: ${rawProto}` });
      return;
    }
    const protocol = rawProto as GatewayProtocol;

    const hostArg = typeof msg.host === 'string' ? msg.host.trim() : '';
    const defaultPort = protocol === 'rdp' ? 3389 : protocol === 'vnc' ? 5900 : 22;
    const portArg = typeof msg.port === 'number' ? msg.port : defaultPort;

    if (protocol !== 'demo') {
      const check = await policy.validate(hostArg, portArg);
      if (!check.ok) {
        sendControl(viewer.conn, {
          type: 'error',
          code: check.code === 'metadata_blocked' ? 'ssrf_blocked' : check.code,
          message: check.reason,
        });
        return;
      }
    }

    const sessionId = requestedSessionId || `gw-${randomUUID().slice(0, 12)}`;
    const encoder = new DirtyRectFrameEncoder();

    const params: OpenSessionParams = {
      sessionId,
      protocol,
      host: hostArg,
      port: portArg,
      username: typeof msg.username === 'string' ? msg.username : undefined,
      password: typeof msg.password === 'string' ? msg.password : undefined,
      domain: typeof msg.domain === 'string' ? msg.domain : undefined,
      certificateSha256: typeof msg.certificateSha256 === 'string' ? msg.certificateSha256 : undefined,
      jumpHost: typeof msg.jumpHost === 'string' ? msg.jumpHost : undefined,
      jumpPassword: typeof msg.jumpPassword === 'string' ? msg.jumpPassword : undefined,
      privateKey: typeof msg.privateKey === 'string' ? msg.privateKey : undefined,
      width: typeof msg.width === 'number' ? msg.width : 1280,
      height: typeof msg.height === 'number' ? msg.height : 720,
      cols: typeof msg.cols === 'number' ? msg.cols : 100,
      rows: typeof msg.rows === 'number' ? msg.rows : 30,
      viewOnly: requestedViewOnly,
    };

    let sessionRef: MultiplexedSession | null = null;
    const pendingFrames: Array<{ rgba: Uint8Array; width: number; height: number; forceKeyframe?: boolean }> = [];
    const pendingSsh: string[] = [];

    const sink: BackendSink = {
      onFrame(rgba, width, height, forceKeyframe) {
        if (!sessionRef) {
          const copy = new Uint8Array(width * height * 4);
          copy.set(rgba.subarray(0, copy.byteLength));
          pendingFrames.push({ rgba: copy, width, height, forceKeyframe });
          return;
        }
        deliverFrameToSession(sessionRef, rgba, width, height, Boolean(forceKeyframe));
      },
      onSshData(data) {
        if (!sessionRef) {
          pendingSsh.push(data);
          return;
        }
        broadcastControl(sessionRef, { type: 'sshData', sessionId: sessionRef.id, data });
      },
      onState(state, reason) {
        if (!sessionRef) return;
        if (state === 'closed' || state === 'failed') {
          broadcastControl(sessionRef, {
            type: state === 'failed' ? 'error' : 'close',
            sessionId: sessionRef.id,
            code: state,
            message: reason ?? state,
          });
          void closeSession(sessionRef);
        }
      },
      onError(code, message) {
        if (!sessionRef) return;
        broadcastControl(sessionRef, { type: 'error', sessionId: sessionRef.id, code, message });
      },
    };

    let backend: GatewayBackend;
    try {
      backend = await sessionFactory(params, sink, { rdpHelperPath, allowDemoSession });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start backend session';
      sendControl(viewer.conn, { type: 'error', code: 'backend_open_failed', message });
      return;
    }

    // If viewer disconnected while backend was opening, clean up immediately (0 orphans!)
    if (!viewer.conn.isOpen) {
      await backend.close().catch(() => {});
      return;
    }

    const session: MultiplexedSession = {
      id: sessionId,
      protocol,
      backend,
      encoder,
      viewers: new Map([[viewer.id, viewer]]),
      controllerId: requestedViewOnly ? null : viewer.id,
      heldKeys: new Set(),
      heldButtons: new Set(),
      seq: 0,
      lastFrame: null,
      closing: false,
    };
    sessionRef = session;
    sessions.set(sessionId, session);
    viewer.sessionId = sessionId;
    viewer.viewOnly = requestedViewOnly;
    viewer.needsKeyframe = true;

    sendControl(viewer.conn, {
      type: 'opened',
      sessionId,
      protocol,
      width: backend.width,
      height: backend.height,
      viewOnly: session.controllerId !== viewer.id,
      hasControl: session.controllerId === viewer.id,
      controllerId: session.controllerId,
      viewers: session.viewers.size,
    });
    broadcastControlState(session);

    for (const chunk of pendingSsh) {
      sendControl(viewer.conn, { type: 'sshData', sessionId, data: chunk });
    }
    for (const f of pendingFrames) {
      deliverFrameToSession(session, f.rgba, f.width, f.height, Boolean(f.forceKeyframe));
    }
  };

  const handleControlMessage = async (viewer: ViewerAttachment, msg: Jsr1ControlMessage): Promise<void> => {
    switch (msg.type) {
      case 'open':
        await handleOpenControl(viewer, msg);
        return;

      case 'takeControl': {
        const session = viewer.sessionId ? sessions.get(viewer.sessionId) : undefined;
        if (!session) return;
        if (session.controllerId !== viewer.id) {
          releaseHeldInputs(session);
          if (session.controllerId) {
            const prev = session.viewers.get(session.controllerId);
            if (prev) prev.viewOnly = true;
          }
          session.controllerId = viewer.id;
          viewer.viewOnly = false;
          broadcastControlState(session);
        }
        return;
      }

      case 'releaseControl': {
        const session = viewer.sessionId ? sessions.get(viewer.sessionId) : undefined;
        if (!session) return;
        if (session.controllerId === viewer.id) {
          releaseHeldInputs(session);
          session.controllerId = null;
          viewer.viewOnly = true;
          broadcastControlState(session);
        }
        return;
      }

      case 'resize': {
        const session = viewer.sessionId ? sessions.get(viewer.sessionId) : undefined;
        if (!session || session.controllerId !== viewer.id) return;
        if (typeof msg.width === 'number' && typeof msg.height === 'number') {
          session.backend.resize?.(msg.width, msg.height);
        }
        return;
      }

      case 'sshData': {
        const session = viewer.sessionId ? sessions.get(viewer.sessionId) : undefined;
        if (!session || session.controllerId !== viewer.id) return;
        if (typeof msg.data === 'string') {
          session.backend.sendSshData?.(msg.data);
        }
        return;
      }

      case 'sshResize': {
        const session = viewer.sessionId ? sessions.get(viewer.sessionId) : undefined;
        if (!session || session.controllerId !== viewer.id) return;
        if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          session.backend.resizeSsh?.(msg.cols, msg.rows);
        }
        return;
      }

      case 'sftpReq': {
        const session = viewer.sessionId ? sessions.get(viewer.sessionId) : undefined;
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : randomUUID();
        if (!session || session.controllerId !== viewer.id) {
          sendControl(viewer.conn, {
            type: 'sftpRes',
            reqId,
            ok: false,
            error: 'Input control required for SFTP operations',
          });
          return;
        }
        if (!session.backend.handleSftp) {
          sendControl(viewer.conn, {
            type: 'sftpRes',
            reqId,
            ok: false,
            error: 'Backend does not support SFTP',
          });
          return;
        }
        const res = await session.backend.handleSftp({
          reqId,
          action: String(msg.action ?? 'list') as SftpRequestPayload['action'],
          path: typeof msg.path === 'string' ? msg.path : '/',
          dataBase64: typeof msg.dataBase64 === 'string' ? msg.dataBase64 : undefined,
          offset: typeof msg.offset === 'number' ? msg.offset : undefined,
          length: typeof msg.length === 'number' ? msg.length : undefined,
        });
        sendControl(viewer.conn, { type: 'sftpRes', reqId, ...res });
        return;
      }

      case 'close':
        await detachViewer(viewer);
        sendControl(viewer.conn, { type: 'close', ok: true });
        return;

      default:
        sendControl(viewer.conn, { type: 'error', code: 'unknown_control', message: `Unknown control type: ${msg.type}` });
    }
  };

  const handleBinaryFromClient = (viewer: ViewerAttachment, payload: Buffer): void => {
    let decoded;
    try {
      decoded = decodeJsr1Message(payload);
    } catch (err) {
      sendControl(viewer.conn, {
        type: 'error',
        code: 'wire_protocol_error',
        message: err instanceof Error ? err.message : 'Invalid JSR1 frame',
      });
      return;
    }

    switch (decoded.type) {
      case Jsr1MsgType.FRAME_ACK: {
        const evalRes = viewer.cc.onFrameAck(decoded.ack.seq, decoded.ack.viewerWaitUs);
        const nowMs = Date.now();
        if (evalRes.matched && nowMs - viewer.lastStatsSentMs >= 500) {
          viewer.lastStatsSentMs = nowMs;
          const stats = viewer.cc.getStats();
          sendControl(viewer.conn, {
            type: 'stats',
            sessionId: viewer.sessionId,
            targetFps: stats.targetFps,
            networkRttUs: stats.lastNetworkRttUs,
            smoothedNetworkRttUs: stats.smoothedNetworkRttUs,
            totalRttUs: stats.lastTotalRttUs,
            viewerWaitUs: stats.lastViewerWaitUs,
            inFlight: stats.inFlightCount,
            maxInFlight: stats.maxInFlight,
            paused: stats.paused,
          });
        }
        return;
      }

      case Jsr1MsgType.INPUT_EVENT: {
        const session = viewer.sessionId ? sessions.get(viewer.sessionId) : undefined;
        if (!session || session.closing) return;
        // Exclusive input lock: view-only observers & non-controllers cannot inject input!
        if (session.controllerId !== viewer.id) return;

        const ev = decoded.input;
        if (ev.kind === Jsr1InputKind.KEY_DOWN) {
          session.heldKeys.add(ev.codeOrDelta);
        } else if (ev.kind === Jsr1InputKind.KEY_UP) {
          session.heldKeys.delete(ev.codeOrDelta);
        } else if (ev.kind === Jsr1InputKind.DOWN) {
          session.heldButtons.add(ev.codeOrDelta);
        } else if (ev.kind === Jsr1InputKind.UP) {
          session.heldButtons.delete(ev.codeOrDelta);
        }
        session.backend.sendInput(ev);
        return;
      }

      case Jsr1MsgType.CONTROL_JSON:
        void handleControlMessage(viewer, decoded.control).catch((err) => {
          sendControl(viewer.conn, {
            type: 'error',
            code: 'control_error',
            message: err instanceof Error ? err.message : 'Control message failed',
          });
        });
        return;

      case Jsr1MsgType.FRAME_TILE:
        // Clients do not send FRAME_TILE upstream
        return;
    }
  };

  const applyCorsHeaders = (req: IncomingMessage, res: ServerResponse): void => {
    const allowedOrigin = isAllowedCorsOrigin(req.headers.origin, corsOrigins);
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };

  const sendJson = (res: ServerResponse, statusCode: number, data: Record<string, unknown>): void => {
    const body = JSON.stringify(data);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  };

  const handleStaticUi = async (rawPathname: string, res: ServerResponse): Promise<boolean> => {
    if (!serveUi) return false;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPathname);
    } catch {
      res.statusCode = 400;
      res.end('Bad Request');
      return true;
    }
    if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }
    const segments = decodedPath.split('/').filter(Boolean);
    if (segments.some((seg) => seg === '..')) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }

    const isAsset = decodedPath.startsWith('/assets/');
    const baseDir = isAsset ? assetsDir : uiDir;
    const rel = isAsset
      ? decodedPath.slice('/assets/'.length)
      : decodedPath === '/'
        ? 'index.html'
        : decodedPath.replace(/^\/+/, '');
    if (!rel) return false;

    const fullPath = resolve(baseDir, rel);
    if (fullPath !== baseDir && !fullPath.startsWith(`${baseDir}${sep}`)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }
    try {
      const info = await stat(fullPath);
      if (!info.isFile()) return false;
      const content = await readFile(fullPath);
      const mime = MIME_TYPES[extname(fullPath).toLowerCase()] ?? 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', content.byteLength);
      res.end(content);
      return true;
    } catch {
      return false;
    }
  };

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      applyCorsHeaders(req, res);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = parsedUrl.pathname;

      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          version: GATEWAY_VERSION,
          protocol: GATEWAY_PROTOCOL,
          pairingActive: auth.pairing.isActive(),
          demoEnabled: allowDemoSession,
          activeSessions: sessions.size,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/pair/exchange') {
        let body: Record<string, unknown>;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          sendJson(res, status, { ok: false, error: (err as Error).message });
          return;
        }
        const exchanged = auth.exchangePairingCode(body.code);
        if (!exchanged.ok) {
          if (exchanged.retryAfterSec) {
            res.setHeader('Retry-After', String(exchanged.retryAfterSec));
          }
          sendJson(res, exchanged.status, {
            ok: false,
            error: exchanged.error,
            ...(exchanged.retryAfterSec ? { retryAfterSec: exchanged.retryAfterSec } : {}),
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          token: exchanged.token,
          expiresInSec: exchanged.expiresInSec,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/tickets') {
        const result = auth.issueTicketForAuthorizedRequest(
          req.headers.authorization,
          req.socket.remoteAddress,
        );
        if (!result.ok) {
          sendJson(res, result.status, { ok: false, error: result.error });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          ticket: result.issued.ticket,
          expiresInSec: result.issued.expiresInSec,
        });
        return;
      }

      if (req.method === 'GET' && serveUi) {
        const served = await handleStaticUi(pathname, res);
        if (served) return;
      }

      sendJson(res, 404, { ok: false, error: 'Not Found' });
    })().catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'Internal Server Error' });
      }
    });
  };

  const server: HttpServer | HttpsServer = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, requestHandler)
    : createHttpServer(requestHandler);

  const openSockets = new Set<import('node:net').Socket>();
  server.on('connection', (sock) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (parsedUrl.pathname !== '/ws' && parsedUrl.pathname !== '/stream' && parsedUrl.pathname !== '/') {
      rejectUpgrade(socket, 404, 'WebSocket endpoint is /ws');
      return;
    }

    const authResult = auth.authenticateUpgrade(req.headers['sec-websocket-protocol']);
    if (!authResult.ok) {
      rejectUpgrade(socket, 401, `Unauthorized WebSocket upgrade (${authResult.reason})`);
      return;
    }

    const conn = acceptWebSocketUpgrade(req, socket, head, {
      subprotocol: authResult.subprotocol,
    });
    if (!conn) return;

    const viewer: ViewerAttachment = {
      id: `client-${randomUUID().slice(0, 10)}`,
      conn,
      sessionId: null,
      viewOnly: false,
      cc: new ClosedLoopCongestionController({ maxInFlight: maxInFlightFrames }),
      needsKeyframe: true,
      lastStatsSentMs: 0,
    };
    clients.set(viewer.id, viewer);

    conn.setCallbacks({
      onBinary: (payload) => handleBinaryFromClient(viewer, payload),
      onClose: () => {
        clients.delete(viewer.id);
        void detachViewer(viewer);
      },
      onError: () => {
        clients.delete(viewer.id);
        void detachViewer(viewer);
      },
    });
  });

  let boundPort = requestedPort;
  const proto: 'http' | 'https' = options.tls ? 'https' : 'http';

  return {
    server,
    auth,
    policy,
    get port() {
      return boundPort;
    },
    host,
    protocol: proto,
    activeSessionCount: () => sessions.size,
    activeClientCount: () => clients.size,
    listen(): Promise<{ host: string; port: number; url: string; wsUrl: string }> {
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(requestedPort, host, () => {
          server.off('error', rejectListen);
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            boundPort = addr.port;
          }
          const url = `${proto}://${host}:${boundPort}`;
          const wsProto = proto === 'https' ? 'wss' : 'ws';
          resolveListen({ host, port: boundPort, url, wsUrl: `${wsProto}://${host}:${boundPort}/ws` });
        });
      });
    },
    async close(): Promise<void> {
      for (const viewer of [...clients.values()]) {
        viewer.conn.close(1001, 'gateway shutting down');
      }
      clients.clear();
      await Promise.allSettled([...sessions.values()].map((s) => closeSession(s)));
      sessions.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
        for (const sock of openSockets) {
          sock.destroy();
        }
        openSockets.clear();
      });
    },
  };
}

function parseCliArgs(argv: readonly string[]): {
  host: string;
  port: number;
  serveUi: boolean;
  uiDir?: string;
  allowDemoSession: boolean;
  token?: string;
  tlsCert?: string;
  tlsKey?: string;
  allowCidrs: string[];
  denyCidrs: string[];
  corsOrigins?: string[];
  rdpHelperPath?: string;
} {
  const allowCidrs = (process.env.JALADESK_GATEWAY_ALLOW_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const denyCidrs = (process.env.JALADESK_GATEWAY_DENY_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const envCors = (process.env.JALADESK_GATEWAY_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const cfg: ReturnType<typeof parseCliArgs> = {
    host: process.env.JALADESK_GATEWAY_HOST || '127.0.0.1',
    port: Number(process.env.JALADESK_GATEWAY_PORT) || 8443,
    serveUi: process.env.JALADESK_GATEWAY_SERVE_UI === '1' || process.env.JALADESK_GATEWAY_SERVE_UI === 'true',
    allowDemoSession: process.env.JALADESK_GATEWAY_DEMO === '1' || process.env.JALADESK_GATEWAY_DEMO === 'true',
    token: process.env.JALADESK_GATEWAY_TOKEN,
    tlsCert: process.env.JALADESK_GATEWAY_TLS_CERT,
    tlsKey: process.env.JALADESK_GATEWAY_TLS_KEY,
    allowCidrs,
    denyCidrs,
    ...(envCors.length > 0 ? { corsOrigins: envCors } : {}),
    rdpHelperPath: process.env.JALADESK_RDP_HELPER,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--host' && next) {
      cfg.host = next;
      i++;
    } else if (arg === '--port' && next) {
      cfg.port = Number(next);
      i++;
    } else if (arg === '--serve-ui') {
      cfg.serveUi = true;
    } else if (arg === '--ui-dir' && next) {
      cfg.uiDir = next;
      cfg.serveUi = true;
      i++;
    } else if (arg === '--demo-session') {
      cfg.allowDemoSession = true;
    } else if (arg === '--token' && next) {
      cfg.token = next;
      i++;
    } else if (arg === '--tls-cert' && next) {
      cfg.tlsCert = next;
      i++;
    } else if (arg === '--tls-key' && next) {
      cfg.tlsKey = next;
      i++;
    } else if (arg === '--allow-cidr' && next) {
      cfg.allowCidrs.push(next);
      i++;
    } else if (arg === '--deny-cidr' && next) {
      cfg.denyCidrs.push(next);
      i++;
    } else if (arg === '--rdp-helper' && next) {
      cfg.rdpHelperPath = next;
      i++;
    }
  }
  return cfg;
}

async function runCli(): Promise<void> {
  const cfg = parseCliArgs(process.argv.slice(2));
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (cfg.tlsCert && cfg.tlsKey) {
    tls = {
      cert: await readFile(cfg.tlsCert),
      key: await readFile(cfg.tlsKey),
    };
  }

  const gw = createGatewayServer({
    host: cfg.host,
    port: cfg.port,
    serveUi: cfg.serveUi,
    uiDir: cfg.uiDir,
    allowDemoSession: cfg.allowDemoSession,
    auth: { token: cfg.token },
    targetPolicy: {
      allowCidrs: cfg.allowCidrs,
      denyCidrs: cfg.denyCidrs,
    },
    corsOrigins: cfg.corsOrigins,
    rdpHelperPath: cfg.rdpHelperPath,
    tls,
  });

  const info = await gw.listen();
  const pairing = gw.auth.pairing.getActiveCodeForCli();
  const lines = [
    `[JalaDesk Web Gateway v${GATEWAY_VERSION}] Listening on ${info.url}`,
    `  WebSocket:     ${info.wsUrl} (protocol: ${GATEWAY_PROTOCOL})`,
    `  Healthcheck:   ${info.url}/healthz`,
    `  Pairing Code:  ${pairing ? pairing.code : 'none'} (valid ${pairing ? pairing.expiresInSec : 0}s, single-use)`,
    `  PAIRING_CODE=${pairing ? pairing.code : ''}`,
    `  Session Token: ${gw.auth.getMasterTokenForCli()}`,
    `  Static Web UI: ${cfg.serveUi ? 'enabled' : 'disabled'}`,
    `  Demo Session:  ${cfg.allowDemoSession ? 'enabled' : 'disabled'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  const shutdown = () => {
    void gw.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const isDirectEntry =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  void runCli().catch((err) => {
    process.stderr.write(`Fatal gateway startup error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
