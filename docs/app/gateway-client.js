/**
 * JalaDesk Self-Hosted Web Gateway — Pure Browser ES Module Client (JSR1 Protocol)
 *
 * Connects to a self-hosted JalaDesk Docker Gateway over RFC 6455 binary WebSocket:
 *   1. Exchanges a 6-digit pairing code via POST /api/pair/exchange -> bearer token (RAM-only).
 *   2. Acquires a 60-second single-use ticket via POST /api/tickets (Authorization: Bearer).
 *   3. Opens WebSocket with Sec-WebSocket-Protocol: ['ticket.' + ticket] (never in query string).
 *   4. Decodes JSR1 binary dirty-rect PNG tiles onto <canvas> via createImageBitmap,
 *      measures decode+paint viewerWaitUs, and returns binary 0x02 FRAME_ACK for closed-loop CC.
 *   5. Maps pointer coordinates proportionally across Fit / Fill / 1:1 canvas modes (0..65535),
 *      sends binary HID events & Unicode text (1-click 2FA Auto-Type), and manages SSH/SFTP control.
 */

export const JSR1_MAGIC_0 = 0x4a; // 'J'
export const JSR1_MAGIC_1 = 0x53; // 'S'
export const JSR1_MAGIC_2 = 0x52; // 'R'
export const JSR1_MAGIC_3 = 0x31; // '1'

export const JSR1_FRAME_TILE_HEADER_BYTES = 35;
export const JSR1_FRAME_ACK_BYTES = 13;
export const JSR1_INPUT_HEADER_BYTES = 18;
export const JSR1_CONTROL_HEADER_BYTES = 5;
export const JSR1_MAX_UNICODE_BYTES = 4096;

export const JSR1_MSG_TYPE = Object.freeze({
  FRAME_TILE: 0x01,
  FRAME_ACK: 0x02,
  INPUT_EVENT: 0x03,
  CONTROL_JSON: 0x04,
});

export const JSR1_TILE_CODEC = Object.freeze({
  PNG: 1,
  RAW_DEFLATE: 2,
});

export const JSR1_TILE_FLAGS = Object.freeze({
  NONE: 0x00,
  KEYFRAME: 0x01,
});

export const JSR1_INPUT_KIND = Object.freeze({
  MOVE: 1,
  DOWN: 2,
  UP: 3,
  WHEEL: 4,
  KEY_DOWN: 5,
  KEY_UP: 6,
  UNICODE: 7,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function clampU16(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 0xffff) return 0xffff;
  return Math.round(v);
}

function clampU32(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 0xffffffff) return 0xffffffff;
  return Math.round(v);
}

function clampI32(v) {
  if (!Number.isFinite(v)) return 0;
  const n = Math.trunc(v);
  if (n < -0x80000000) return -0x80000000;
  if (n > 0x7fffffff) return 0x7fffffff;
  return n;
}

/**
 * Normalize a user-supplied Gateway URL (ws://, wss://, http://, or https://)
 * into clean HTTP base URL (for /api/*) and WebSocket endpoint (/ws).
 */
export function normalizeGatewayEndpoints(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('Gateway URL is required.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid wss://, ws://, https://, or http:// gateway URL.');
  }

  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'wss:' && proto !== 'ws:' && proto !== 'https:' && proto !== 'http:') {
    throw new Error('Gateway URL must use wss://, https://, ws://, or http://.');
  }

  const isLocal =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]';

  if ((proto === 'ws:' || proto === 'http:') && !isLocal) {
    // Allow user-configured private LAN gateways, but prefer TLS outside localhost
  }

  const isSecure = proto === 'wss:' || proto === 'https:';
  const httpProto = isSecure ? 'https:' : 'http:';
  const wsProto = isSecure ? 'wss:' : 'ws:';

  let cleanPath = parsed.pathname.replace(/\/+$/, '');
  let wsPath = '/ws';
  if (cleanPath.endsWith('/ws')) {
    wsPath = cleanPath;
    cleanPath = cleanPath.slice(0, -3);
  } else if (cleanPath.endsWith('/stream')) {
    wsPath = cleanPath;
    cleanPath = cleanPath.slice(0, -7);
  } else if (cleanPath) {
    wsPath = `${cleanPath}/ws`;
  }

  const httpBaseUrl = `${httpProto}//${parsed.host}${cleanPath}`;
  const wsUrl = `${wsProto}//${parsed.host}${wsPath}`;
  return {
    httpBaseUrl,
    wsUrl,
    origin: `${httpProto}//${parsed.host}`,
    isSecure,
  };
}

/**
 * Parse a URL hash fragment such as `#gateway=http://127.0.0.1:8443&token=<hex>`
 * or `#token=<hex>` for 1-click auto-pairing from JalaDesk Desktop.
 * Returns null if no gateway/token parameter is present or if it is an OAuth fragment.
 */
export function parseGatewayFragment(rawHash) {
  const cleaned = String(rawHash || '').replace(/^#/, '').trim();
  if (!cleaned || cleaned.includes('access_token=')) {
    return null;
  }
  if (!cleaned.includes('token=') && !cleaned.includes('gateway=')) {
    return null;
  }

  const params = new URLSearchParams(cleaned);
  const token = (params.get('token') || '').trim();
  const rawGateway = (params.get('gateway') || '').trim();
  let gatewayUrl = '';
  if (rawGateway) {
    try {
      const normalized = normalizeGatewayEndpoints(rawGateway);
      gatewayUrl = normalized.httpBaseUrl;
    } catch {
      gatewayUrl = '';
    }
  }

  if (!token && !gatewayUrl) {
    return null;
  }
  return {
    hasPairing: Boolean(token),
    gatewayUrl,
    token,
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Probe GET /healthz on a self-hosted JalaDesk Gateway.
 */
export async function checkGatewayHealth(gatewayBaseUrl) {
  const { httpBaseUrl } = normalizeGatewayEndpoints(gatewayBaseUrl);
  const res = await fetch(`${httpBaseUrl}/healthz`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
  });
  const body = await parseJsonResponse(res);
  if (!res.ok) {
    throw new Error(body.message || body.error || `Gateway health check failed (HTTP ${res.status}).`);
  }
  return body;
}

/**
 * Exchange a 6-digit pairing code for a RAM-only Gateway bearer token.
 * POST /api/pair/exchange -> { token, expiresInSec }
 */
export async function exchangePairingCode(gatewayBaseUrl, sixDigitCode) {
  const { httpBaseUrl } = normalizeGatewayEndpoints(gatewayBaseUrl);
  const code = String(sixDigitCode || '').replace(/\s+/g, '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw new Error('Pairing code must be exactly 6 numeric digits.');
  }

  let res;
  try {
    res = await fetch(`${httpBaseUrl}/api/pair/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new Error(`Unable to reach gateway at ${httpBaseUrl}. Verify the gateway container is running and CORS allows this origin.`);
  }

  const body = await parseJsonResponse(res);
  if (!res.ok || !body || typeof body.token !== 'string' || !body.token) {
    if (res.status === 429) {
      const retry = res.headers.get('Retry-After');
      throw new Error(
        body.message ||
          body.error ||
          `Pairing code locked after too many attempts${retry ? ` (retry in ${retry}s)` : ''}.`,
      );
    }
    throw new Error(body.message || body.error || `Pairing code exchange failed (HTTP ${res.status}).`);
  }
  return {
    token: body.token,
    expiresInSec: Number(body.expiresInSec) || 0,
  };
}

/**
 * Request a 60-second single-use WebSocket ticket using the RAM-only bearer token.
 * POST /api/tickets (Authorization: Bearer <token>) -> { ticket, expiresInSec }
 */
export async function requestWsTicket(gatewayBaseUrl, bearerToken) {
  const { httpBaseUrl } = normalizeGatewayEndpoints(gatewayBaseUrl);
  const token = String(bearerToken || '').trim();
  if (!token) {
    throw new Error('Gateway bearer token is required to request a WebSocket ticket.');
  }

  let res;
  try {
    res = await fetch(`${httpBaseUrl}/api/tickets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new Error(`Unable to reach gateway at ${httpBaseUrl} for ticket issuance.`);
  }

  const body = await parseJsonResponse(res);
  if (!res.ok || !body || typeof body.ticket !== 'string' || !body.ticket) {
    throw new Error(body.message || body.error || `WebSocket ticket request rejected (HTTP ${res.status}).`);
  }
  return {
    ticket: body.ticket,
    expiresInSec: Number(body.expiresInSec) || 60,
  };
}

/* ==========================================================================
   JSR1 Binary Codec (Big-Endian)
   ========================================================================== */

export function encodeFrameAck(seq, viewerWaitUs) {
  const buf = new Uint8Array(JSR1_FRAME_ACK_BYTES);
  const view = new DataView(buf.buffer);
  buf[0] = JSR1_MAGIC_0;
  buf[1] = JSR1_MAGIC_1;
  buf[2] = JSR1_MAGIC_2;
  buf[3] = JSR1_MAGIC_3;
  buf[4] = JSR1_MSG_TYPE.FRAME_ACK;
  view.setUint32(5, clampU32(seq), false);
  view.setUint32(9, clampU32(viewerWaitUs), false);
  return buf;
}

export function encodeInputEvent({ kind, normX = 0, normY = 0, codeOrDelta = 0, flags = 0, text = '' }) {
  const textBytes = text ? textEncoder.encode(String(text)) : new Uint8Array(0);
  if (textBytes.byteLength > JSR1_MAX_UNICODE_BYTES) {
    throw new RangeError(`JSR1 input text exceeds ${JSR1_MAX_UNICODE_BYTES} UTF-8 bytes`);
  }
  const buf = new Uint8Array(JSR1_INPUT_HEADER_BYTES + textBytes.byteLength);
  const view = new DataView(buf.buffer);
  buf[0] = JSR1_MAGIC_0;
  buf[1] = JSR1_MAGIC_1;
  buf[2] = JSR1_MAGIC_2;
  buf[3] = JSR1_MAGIC_3;
  buf[4] = JSR1_MSG_TYPE.INPUT_EVENT;
  buf[5] = kind & 0xff;
  view.setUint16(6, clampU16(normX), false);
  view.setUint16(8, clampU16(normY), false);
  view.setInt32(10, clampI32(codeOrDelta), false);
  view.setUint16(14, clampU16(flags), false);
  view.setUint16(16, textBytes.byteLength, false);
  if (textBytes.byteLength > 0) {
    buf.set(textBytes, JSR1_INPUT_HEADER_BYTES);
  }
  return buf;
}

export function encodeControlJson(msg) {
  const jsonBytes = textEncoder.encode(JSON.stringify(msg));
  const buf = new Uint8Array(JSR1_CONTROL_HEADER_BYTES + jsonBytes.byteLength);
  buf[0] = JSR1_MAGIC_0;
  buf[1] = JSR1_MAGIC_1;
  buf[2] = JSR1_MAGIC_2;
  buf[3] = JSR1_MAGIC_3;
  buf[4] = JSR1_MSG_TYPE.CONTROL_JSON;
  buf.set(jsonBytes, JSR1_CONTROL_HEADER_BYTES);
  return buf;
}

export function decodeJsr1Frame(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 5) {
    throw new Error('JSR1 frame too short');
  }
  if (
    bytes[0] !== JSR1_MAGIC_0 ||
    bytes[1] !== JSR1_MAGIC_1 ||
    bytes[2] !== JSR1_MAGIC_2 ||
    bytes[3] !== JSR1_MAGIC_3
  ) {
    throw new Error('JSR1 invalid magic header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const msgType = bytes[4];

  if (msgType === JSR1_MSG_TYPE.FRAME_TILE) {
    if (bytes.byteLength < JSR1_FRAME_TILE_HEADER_BYTES) {
      throw new Error('JSR1 FRAME_TILE header truncated');
    }
    const seq = view.getUint32(5, false);
    const sentUsHi = view.getUint32(9, false);
    const sentUsLo = view.getUint32(13, false);
    const sentUs = sentUsHi * 4294967296 + sentUsLo;
    const x = view.getUint16(17, false);
    const y = view.getUint16(19, false);
    const w = view.getUint16(21, false);
    const h = view.getUint16(23, false);
    const fullW = view.getUint16(25, false);
    const fullH = view.getUint16(27, false);
    const codec = bytes[29];
    const flags = bytes[30];
    const payloadLen = view.getUint32(31, false);
    if (bytes.byteLength !== JSR1_FRAME_TILE_HEADER_BYTES + payloadLen) {
      throw new Error(
        `JSR1 FRAME_TILE length mismatch: expected ${JSR1_FRAME_TILE_HEADER_BYTES + payloadLen}, got ${bytes.byteLength}`,
      );
    }
    const payload = bytes.subarray(
      JSR1_FRAME_TILE_HEADER_BYTES,
      JSR1_FRAME_TILE_HEADER_BYTES + payloadLen,
    );
    return {
      type: JSR1_MSG_TYPE.FRAME_TILE,
      tile: { seq, sentUs, x, y, w, h, fullW, fullH, codec, flags, payload },
    };
  }

  if (msgType === JSR1_MSG_TYPE.CONTROL_JSON) {
    const jsonText = textDecoder.decode(bytes.subarray(JSR1_CONTROL_HEADER_BYTES));
    const control = JSON.parse(jsonText);
    return { type: JSR1_MSG_TYPE.CONTROL_JSON, control };
  }

  if (msgType === JSR1_MSG_TYPE.FRAME_ACK) {
    if (bytes.byteLength !== JSR1_FRAME_ACK_BYTES) {
      throw new Error('JSR1 FRAME_ACK invalid length');
    }
    return {
      type: JSR1_MSG_TYPE.FRAME_ACK,
      ack: {
        seq: view.getUint32(5, false),
        viewerWaitUs: view.getUint32(9, false),
      },
    };
  }

  if (msgType === JSR1_MSG_TYPE.INPUT_EVENT) {
    if (bytes.byteLength < JSR1_INPUT_HEADER_BYTES) {
      throw new Error('JSR1 INPUT_EVENT header truncated');
    }
    const textLen = view.getUint16(16, false);
    return {
      type: JSR1_MSG_TYPE.INPUT_EVENT,
      input: {
        kind: bytes[5],
        normX: view.getUint16(6, false),
        normY: view.getUint16(8, false),
        codeOrDelta: view.getInt32(10, false),
        flags: view.getUint16(14, false),
        text: textLen > 0 ? textDecoder.decode(bytes.subarray(JSR1_INPUT_HEADER_BYTES, JSR1_INPUT_HEADER_BYTES + textLen)) : '',
      },
    };
  }

  throw new Error(`Unknown JSR1 message type: 0x${msgType.toString(16)}`);
}

/* ==========================================================================
   Proportional Coordinate Mapping (Fit / Fill / 1:1) & Keyboard Tables
   ========================================================================== */

/**
 * Map a pointer event's viewport coordinates (clientX, clientY) onto resolution-independent
 * fractional coordinates (0..65535) matching the rendered bitmap area inside <canvas>.
 */
export function mapClientPointToNormalized(clientX, clientY, canvasEl, scaleMode = 'fit') {
  if (!canvasEl) return { normX: 0, normY: 0, inside: false };
  const rect = canvasEl.getBoundingClientRect();
  const srcW = canvasEl.width || 1;
  const srcH = canvasEl.height || 1;
  const boxW = rect.width;
  const boxH = rect.height;
  if (boxW <= 0 || boxH <= 0 || srcW <= 0 || srcH <= 0) {
    return { normX: 0, normY: 0, inside: false };
  }

  let drawX = 0;
  let drawY = 0;
  let drawW = boxW;
  let drawH = boxH;

  if (scaleMode === 'fill') {
    const scale = Math.max(boxW / srcW, boxH / srcH);
    drawW = srcW * scale;
    drawH = srcH * scale;
    drawX = (boxW - drawW) / 2;
    drawY = (boxH - drawH) / 2;
  } else if (scaleMode === 'fit') {
    const scale = Math.min(boxW / srcW, boxH / srcH);
    drawW = srcW * scale;
    drawH = srcH * scale;
    drawX = (boxW - drawW) / 2;
    drawY = (boxH - drawH) / 2;
  }

  const u = (clientX - rect.left - drawX) / drawW;
  const v = (clientY - rect.top - drawY) / drawH;
  const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  return {
    normX: clampU16(Math.max(0, Math.min(1, u)) * 65535),
    normY: clampU16(Math.max(0, Math.min(1, v)) * 65535),
    inside,
  };
}

/** DOM KeyboardEvent.code -> IBM PC/XT scancode (RDP & Demo) */
const DOM_CODE_TO_SCANCODE = Object.freeze({
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Home: 0x147,
  ArrowUp: 0x148,
  PageUp: 0x149,
  ArrowLeft: 0x14b,
  ArrowRight: 0x14d,
  End: 0x14f,
  ArrowDown: 0x150,
  PageDown: 0x151,
  Insert: 0x152,
  Delete: 0x153,
  F11: 87,
  F12: 88,
  NumpadEnter: 0x11c,
  ControlRight: 0x11d,
  AltRight: 0x138,
  MetaLeft: 0x15b,
  MetaRight: 0x15c,
});

const DOM_KEY_TO_X11_KEYSYM = Object.freeze({
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Insert: 0xff63,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
});

export function domCodeToScanCode(code) {
  return DOM_CODE_TO_SCANCODE[code] || 0;
}

export function domKeyToX11Keysym(key, code = '') {
  if (DOM_KEY_TO_X11_KEYSYM[key]) return DOM_KEY_TO_X11_KEYSYM[key];
  if (code === 'ShiftRight') return 0xffe2;
  if (code === 'ControlRight') return 0xffe4;
  if (code === 'AltRight') return 0xffea;
  if (typeof key === 'string' && key.length === 1) {
    const cp = key.codePointAt(0);
    if (cp && cp >= 0x20 && cp <= 0x7e) return cp;
    if (cp && cp > 0x7e) return 0x01000000 | cp;
  }
  return 0;
}

function getModifierFlags(ev) {
  let flags = 0;
  if (ev.shiftKey) flags |= 1;
  if (ev.ctrlKey) flags |= 2;
  if (ev.altKey) flags |= 4;
  if (ev.metaKey) flags |= 8;
  return flags;
}

/* ==========================================================================
   JalaGatewayClient — Live JSR1 WebSocket + Dirty-Rect Canvas Renderer
   ========================================================================== */

export class JalaGatewayClient {
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.callbacks = {
      onStatus: options.onStatus || (() => {}),
      onTokenExchanged: options.onTokenExchanged || (() => {}),
      onOpened: options.onOpened || (() => {}),
      onControlState: options.onControlState || (() => {}),
      onStats: options.onStats || (() => {}),
      onMetrics: options.onMetrics || (() => {}),
      onSshData: options.onSshData || (() => {}),
      onSftpRes: options.onSftpRes || (() => {}),
      onLog: options.onLog || (() => {}),
      onError: options.onError || (() => {}),
      onClose: options.onClose || (() => {}),
    };

    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.sessionId = '';
    this.protocol = '';
    this.remoteWidth = 0;
    this.remoteHeight = 0;
    this.viewOnly = false;
    this.hasControl = false;
    this.controllerId = null;
    this.viewers = 0;

    // Telemetry state
    this.tilesDecoded = 0;
    this.fps = 0;
    this.rttMs = 0;
    this.kbPerSec = 0;
    this.lastViewerWaitUs = 0;
    this.targetFps = 0;
    this.inFlight = 0;
    this.paused = false;

    this._frameTimestamps = [];
    this._byteSamples = [];
    this._metricsTimer = null;
    this._tileQueue = Promise.resolve();
    this._heldKeys = new Set();
    this._pendingSftp = new Map();
    this._sftpSeq = 0;
    this._lastMoveSentAt = 0;
    this._canvasDisposer = null;
    this._windowBlurHandler = () => {
      this.releaseAllHeldKeys();
    };
  }

  setCanvas(canvasEl) {
    this.canvas = canvasEl;
  }

  getTelemetry() {
    return {
      connected: this.connected,
      sessionId: this.sessionId,
      protocol: this.protocol,
      viewOnly: this.viewOnly,
      hasControl: this.hasControl,
      viewers: this.viewers,
      remoteWidth: this.remoteWidth,
      remoteHeight: this.remoteHeight,
      tilesDecoded: this.tilesDecoded,
      fps: this.fps,
      rttMs: this.rttMs,
      kbPerSec: this.kbPerSec,
      lastViewerWaitUs: this.lastViewerWaitUs,
      targetFps: this.targetFps,
      inFlight: this.inFlight,
      paused: this.paused,
    };
  }

  async connect({ gatewayUrl, bearerToken = '', pairingCode = '', openParams = {} }) {
    this.disconnect(false);
    this.connecting = true;
    this.callbacks.onStatus('CONNECTING', 'warn');

    const endpoints = normalizeGatewayEndpoints(gatewayUrl);
    let activeToken = String(bearerToken || '').trim();

    if (!activeToken) {
      if (!pairingCode) {
        this.connecting = false;
        this.callbacks.onStatus('DISCONNECTED', 'idle');
        throw new Error('Provide either a 6-digit pairing code or an ephemeral session token.');
      }
      this.callbacks.onLog(`Exchanging 6-digit pairing code at ${endpoints.httpBaseUrl}/api/pair/exchange...`, 'default');
      const exchanged = await exchangePairingCode(endpoints.httpBaseUrl, pairingCode);
      activeToken = exchanged.token;
      this.callbacks.onTokenExchanged(activeToken);
      this.callbacks.onLog('Pairing code accepted. Ephemeral session token stored in RAM only.', 'ok');
    }

    this.callbacks.onLog(`Requesting 60s single-use WebSocket ticket from ${endpoints.httpBaseUrl}/api/tickets...`, 'default');
    const { ticket } = await requestWsTicket(endpoints.httpBaseUrl, activeToken);
    this.callbacks.onLog('Single-use WS ticket acquired. Opening JSR1 binary WebSocket...', 'ok');

    this._resetTelemetry();

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(endpoints.wsUrl, [`ticket.${ticket}`]);
      } catch (err) {
        this.connecting = false;
        this.callbacks.onStatus('DISCONNECTED', 'idle');
        reject(err);
        return;
      }

      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      if (typeof window !== 'undefined') {
        window.addEventListener('blur', this._windowBlurHandler);
      }

      ws.addEventListener('open', () => {
        if (this.ws !== ws) return;
        this.connecting = false;
        this.connected = true;
        this.callbacks.onStatus('CONNECTED', 'ok');
        this.callbacks.onLog(`JSR1 WebSocket established (${endpoints.wsUrl}). Opening target session...`, 'ok');
        this._startMetricsLoop();

        this.sendControl({
          type: 'open',
          ...openParams,
        });

        if (!settled) {
          settled = true;
          resolve({ wsUrl: endpoints.wsUrl });
        }
      });

      ws.addEventListener('message', (ev) => {
        if (this.ws !== ws) return;
        this._handleRawMessage(ev.data);
      });

      ws.addEventListener('error', () => {
        if (this.ws !== ws) return;
        const err = new Error(`WebSocket connection error on ${endpoints.wsUrl}.`);
        this.callbacks.onLog(err.message, 'err');
        if (!settled) {
          settled = true;
          this.connecting = false;
          reject(err);
        }
      });

      ws.addEventListener('close', (ev) => {
        if (this.ws !== ws) return;
        const wasConnected = this.connected;
        this._cleanupConnectionState();
        this.callbacks.onStatus('DISCONNECTED', 'idle');
        this.callbacks.onClose({ code: ev.code, reason: ev.reason || '', wasConnected });
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before open (code ${ev.code}).`));
        }
      });
    });
  }

  _resetTelemetry() {
    this.tilesDecoded = 0;
    this.fps = 0;
    this.rttMs = 0;
    this.kbPerSec = 0;
    this.lastViewerWaitUs = 0;
    this.targetFps = 0;
    this.inFlight = 0;
    this.paused = false;
    this._frameTimestamps = [];
    this._byteSamples = [];
    this._tileQueue = Promise.resolve();
  }

  _startMetricsLoop() {
    this._stopMetricsLoop();
    this._metricsTimer = setInterval(() => {
      this._recomputeRollingMetrics();
      this.callbacks.onMetrics(this.getTelemetry());
    }, 500);
  }

  _stopMetricsLoop() {
    if (this._metricsTimer) {
      clearInterval(this._metricsTimer);
      this._metricsTimer = null;
    }
  }

  _recomputeRollingMetrics() {
    const now = performance.now();
    const cutoff = now - 1000;
    while (this._frameTimestamps.length > 0 && this._frameTimestamps[0] < cutoff) {
      this._frameTimestamps.shift();
    }
    while (this._byteSamples.length > 0 && this._byteSamples[0].ts < cutoff) {
      this._byteSamples.shift();
    }
    this.fps = this._frameTimestamps.length;
    let totalBytes = 0;
    for (const s of this._byteSamples) {
      totalBytes += s.bytes;
    }
    this.kbPerSec = Math.round((totalBytes / 1024) * 10) / 10;
  }

  _handleRawMessage(data) {
    if (!(data instanceof ArrayBuffer)) {
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          this._handleControlMessage(parsed);
        } catch {
          this.callbacks.onLog(`Text message: ${data.slice(0, 160)}`, 'default');
        }
      }
      return;
    }

    const now = performance.now();
    this._byteSamples.push({ ts: now, bytes: data.byteLength });

    let decoded;
    try {
      decoded = decodeJsr1Frame(data);
    } catch (err) {
      this.callbacks.onLog(
        `JSR1 decode error: ${err instanceof Error ? err.message : String(err)}`,
        'err',
      );
      return;
    }

    if (decoded.type === JSR1_MSG_TYPE.FRAME_TILE) {
      this._enqueueTileDecode(decoded.tile, now);
    } else if (decoded.type === JSR1_MSG_TYPE.CONTROL_JSON) {
      this._handleControlMessage(decoded.control);
    }
  }

  _enqueueTileDecode(tile, receivedAtMs) {
    // Copy tile bytes so underlying ArrayBuffer isn't referenced across async microtasks
    const payloadCopy = new Uint8Array(tile.payload.byteLength);
    payloadCopy.set(tile.payload);

    this._tileQueue = this._tileQueue
      .then(async () => {
        if (!this.connected) return;
        const t0 = receivedAtMs || performance.now();
        let bitmap = null;
        try {
          if (tile.codec === JSR1_TILE_CODEC.PNG) {
            const blob = new Blob([payloadCopy], { type: 'image/png' });
            if (typeof createImageBitmap === 'function') {
              bitmap = await createImageBitmap(blob);
            }
          }
          if (bitmap && this.canvas) {
            if (
              tile.fullW > 0 &&
              tile.fullH > 0 &&
              (this.canvas.width !== tile.fullW || this.canvas.height !== tile.fullH)
            ) {
              this.canvas.width = tile.fullW;
              this.canvas.height = tile.fullH;
              this.remoteWidth = tile.fullW;
              this.remoteHeight = tile.fullH;
            }
            const ctx = this.canvas.getContext('2d', { alpha: false });
            if (ctx) {
              ctx.drawImage(bitmap, tile.x, tile.y, tile.w, tile.h);
            }
          }
        } catch (err) {
          this.callbacks.onLog(
            `Tile #${tile.seq} decode failed: ${err instanceof Error ? err.message : String(err)}`,
            'warn',
          );
        } finally {
          if (bitmap && typeof bitmap.close === 'function') {
            try {
              bitmap.close();
            } catch {
              // Ignore bitmap close error
            }
          }
        }

        const viewerWaitUs = Math.max(0, Math.round((performance.now() - t0) * 1000));
        this.lastViewerWaitUs = viewerWaitUs;
        this.tilesDecoded += 1;
        this._frameTimestamps.push(performance.now());
        this._recomputeRollingMetrics();

        // Immediately send binary 0x02 FRAME_ACK for closed-loop congestion control
        this._sendBinary(encodeFrameAck(tile.seq, viewerWaitUs));
        this.callbacks.onMetrics(this.getTelemetry());
      })
      .catch(() => {
        // Keep queue alive even if a single frame errors
      });
  }

  _handleControlMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'opened': {
        this.sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
        this.protocol = typeof msg.protocol === 'string' ? msg.protocol : '';
        this.remoteWidth = Number(msg.width) || 0;
        this.remoteHeight = Number(msg.height) || 0;
        this.viewOnly = Boolean(msg.viewOnly);
        this.hasControl = Boolean(msg.hasControl);
        this.controllerId = msg.controllerId || null;
        this.viewers = Number(msg.viewers) || 1;
        this.callbacks.onOpened(msg);
        this.callbacks.onMetrics(this.getTelemetry());
        return;
      }
      case 'controlState': {
        this.viewOnly = Boolean(msg.viewOnly);
        this.hasControl = Boolean(msg.hasControl);
        this.controllerId = msg.controllerId || null;
        this.viewers = Number(msg.viewers) || 1;
        if (!this.hasControl) {
          this._heldKeys.clear();
        }
        this.callbacks.onControlState(msg);
        this.callbacks.onMetrics(this.getTelemetry());
        return;
      }
      case 'stats': {
        const netUs =
          Number(msg.smoothedNetworkRttUs) ||
          Number(msg.networkRttUs) ||
          Number(msg.totalRttUs) ||
          0;
        this.rttMs = Math.round((netUs / 1000) * 10) / 10;
        this.targetFps = Number(msg.targetFps) || 0;
        this.inFlight = Number(msg.inFlight) || 0;
        this.paused = Boolean(msg.paused);
        this.callbacks.onStats(msg);
        this.callbacks.onMetrics(this.getTelemetry());
        return;
      }
      case 'sshData': {
        if (typeof msg.data === 'string') {
          this.callbacks.onSshData(msg.data);
        }
        return;
      }
      case 'sftpRes': {
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const pending = this._pendingSftp.get(reqId);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingSftp.delete(reqId);
          pending.resolve(msg);
        }
        this.callbacks.onSftpRes(msg);
        return;
      }
      case 'error': {
        this.callbacks.onError(msg);
        return;
      }
      case 'close': {
        this.callbacks.onLog(`Session closed by gateway (${msg.message || 'ok'}).`, 'warn');
        return;
      }
      default:
        return;
    }
  }

  _sendBinary(bytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  sendControl(msg) {
    return this._sendBinary(encodeControlJson(msg));
  }

  sendResize(width, height) {
    const w = Math.max(320, Math.min(3840, Math.round(width)));
    const h = Math.max(240, Math.min(2160, Math.round(height)));
    return this.sendControl({ type: 'resize', width: w, height: h });
  }

  takeControl() {
    return this.sendControl({ type: 'takeControl' });
  }

  releaseControl() {
    this.releaseAllHeldKeys();
    return this.sendControl({ type: 'releaseControl' });
  }

  canSendInput() {
    return this.connected && this.hasControl && !this.viewOnly;
  }

  sendPointerMove(normX, normY, flags = 0) {
    if (!this.canSendInput()) return false;
    return this._sendBinary(
      encodeInputEvent({ kind: JSR1_INPUT_KIND.MOVE, normX, normY, codeOrDelta: 0, flags }),
    );
  }

  sendPointerDown(normX, normY, button = 0, flags = 0) {
    if (!this.canSendInput()) return false;
    return this._sendBinary(
      encodeInputEvent({ kind: JSR1_INPUT_KIND.DOWN, normX, normY, codeOrDelta: button, flags }),
    );
  }

  sendPointerUp(normX, normY, button = 0, flags = 0) {
    if (!this.canSendInput()) return false;
    return this._sendBinary(
      encodeInputEvent({ kind: JSR1_INPUT_KIND.UP, normX, normY, codeOrDelta: button, flags }),
    );
  }

  sendWheel(normX, normY, delta, horizontal = false) {
    if (!this.canSendInput()) return false;
    return this._sendBinary(
      encodeInputEvent({
        kind: JSR1_INPUT_KIND.WHEEL,
        normX,
        normY,
        codeOrDelta: delta,
        flags: horizontal ? 1 : 0,
      }),
    );
  }

  sendKeyDown(codeOrDelta, flags = 0) {
    if (!this.canSendInput() || !codeOrDelta) return false;
    this._heldKeys.add(codeOrDelta);
    return this._sendBinary(
      encodeInputEvent({ kind: JSR1_INPUT_KIND.KEY_DOWN, codeOrDelta, flags }),
    );
  }

  sendKeyUp(codeOrDelta, flags = 0) {
    if (!codeOrDelta) return false;
    this._heldKeys.delete(codeOrDelta);
    if (!this.connected) return false;
    return this._sendBinary(
      encodeInputEvent({ kind: JSR1_INPUT_KIND.KEY_UP, codeOrDelta, flags }),
    );
  }

  releaseAllHeldKeys() {
    if (this._heldKeys.size === 0) return;
    const keys = Array.from(this._heldKeys);
    this._heldKeys.clear();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const code of keys) {
      this._sendBinary(
        encodeInputEvent({ kind: JSR1_INPUT_KIND.KEY_UP, codeOrDelta: code, flags: 0 }),
      );
    }
  }

  /**
   * Send Unicode text via JSR1 0x03 INPUT_EVENT (kind=7 UNICODE) — ideal for
   * 1-click 2FA Auto-Type and clipboard paste!
   */
  sendText(text) {
    if (!this.canSendInput()) return false;
    const str = String(text || '');
    if (!str) return false;

    // Chunk conservatively so each frame stays well below 4096 UTF-8 bytes
    let sentAny = false;
    const chunkSize = 512;
    for (let i = 0; i < str.length; i += chunkSize) {
      const slice = str.slice(i, i + chunkSize);
      if (this._sendBinary(encodeInputEvent({ kind: JSR1_INPUT_KIND.UNICODE, text: slice }))) {
        sentAny = true;
      }
    }
    return sentAny;
  }

  sendCtrlAltDel() {
    if (!this.canSendInput()) return false;
    const isVnc = this.protocol === 'vnc';
    const ctrl = isVnc ? 0xffe3 : 29;
    const alt = isVnc ? 0xffe9 : 56;
    const del = isVnc ? 0xffff : 0x153;
    this.sendKeyDown(ctrl, 2);
    this.sendKeyDown(alt, 6);
    this.sendKeyDown(del, 6);
    this.sendKeyUp(del, 6);
    this.sendKeyUp(alt, 2);
    this.sendKeyUp(ctrl, 0);
    return true;
  }

  sendSshData(data) {
    if (!this.canSendInput()) return false;
    if (data === null || data === undefined || data === '') return false;
    return this.sendControl({ type: 'sshData', data: String(data) });
  }

  sendSshResize(cols, rows) {
    if (!this.canSendInput()) return false;
    return this.sendControl({
      type: 'sshResize',
      cols: Math.max(20, Math.min(400, Math.floor(cols))),
      rows: Math.max(8, Math.min(200, Math.floor(rows))),
    });
  }

  sftpRequest(action, path, extra = {}, timeoutMs = 15000) {
    if (!this.connected) {
      return Promise.reject(new Error('Gateway is not connected.'));
    }
    const reqId = `sftp_${Date.now().toString(36)}_${++this._sftpSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingSftp.delete(reqId);
        reject(new Error(`SFTP ${action} timed out.`));
      }, timeoutMs);
      this._pendingSftp.set(reqId, { resolve, reject, timer });
      const sent = this.sendControl({
        type: 'sftpReq',
        reqId,
        action,
        path,
        ...extra,
      });
      if (!sent) {
        clearTimeout(timer);
        this._pendingSftp.delete(reqId);
        reject(new Error('Failed to send SFTP request over WebSocket.'));
      }
    });
  }

  /**
   * Bind pointer, wheel, keyboard, and paste listeners on the live <canvas>.
   * Automatically scales coordinates for Fit / Fill / 1:1 and releases held keys on blur.
   */
  attachCanvasInput(canvasEl, getScaleMode = () => 'fit') {
    this.detachCanvasInput();
    if (!canvasEl) return () => {};
    this.canvas = canvasEl;

    const onPointerMove = (ev) => {
      if (!this.canSendInput()) return;
      const now = performance.now();
      if (now - this._lastMoveSentAt < 16) return;
      this._lastMoveSentAt = now;
      const pt = mapClientPointToNormalized(ev.clientX, ev.clientY, canvasEl, getScaleMode());
      if (!pt.inside) return;
      this.sendPointerMove(pt.normX, pt.normY, getModifierFlags(ev));
    };

    const onPointerDown = (ev) => {
      canvasEl.focus({ preventScroll: true });
      if (!this.canSendInput()) return;
      const pt = mapClientPointToNormalized(ev.clientX, ev.clientY, canvasEl, getScaleMode());
      if (!pt.inside) return;
      ev.preventDefault();
      this.sendPointerDown(pt.normX, pt.normY, ev.button, getModifierFlags(ev));
    };

    const onPointerUp = (ev) => {
      if (!this.canSendInput()) return;
      const pt = mapClientPointToNormalized(ev.clientX, ev.clientY, canvasEl, getScaleMode());
      this.sendPointerUp(pt.normX, pt.normY, ev.button, getModifierFlags(ev));
    };

    const onContextMenu = (ev) => {
      if (this.connected) {
        ev.preventDefault();
      }
    };

    const onWheel = (ev) => {
      if (!this.canSendInput()) return;
      const pt = mapClientPointToNormalized(ev.clientX, ev.clientY, canvasEl, getScaleMode());
      if (!pt.inside) return;
      ev.preventDefault();
      if (Math.abs(ev.deltaY) >= Math.abs(ev.deltaX)) {
        const delta = ev.deltaY < 0 ? 120 : -120;
        this.sendWheel(pt.normX, pt.normY, delta, false);
      } else if (ev.deltaX !== 0) {
        const delta = ev.deltaX > 0 ? 120 : -120;
        this.sendWheel(pt.normX, pt.normY, delta, true);
      }
    };

    const onKeyDown = (ev) => {
      if (!this.canSendInput()) return;
      // Preserve browser-level DevTools/refresh shortcuts only if not targeting session
      ev.preventDefault();
      const flags = getModifierFlags(ev);
      if (
        this.protocol === 'demo' &&
        ev.key.length === 1 &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey
      ) {
        this.sendText(ev.key);
        return;
      }
      const code =
        this.protocol === 'vnc'
          ? domKeyToX11Keysym(ev.key, ev.code)
          : domCodeToScanCode(ev.code);
      if (code) {
        this.sendKeyDown(code, flags);
      }
    };

    const onKeyUp = (ev) => {
      if (!this.connected) return;
      ev.preventDefault();
      const flags = getModifierFlags(ev);
      const code =
        this.protocol === 'vnc'
          ? domKeyToX11Keysym(ev.key, ev.code)
          : domCodeToScanCode(ev.code);
      if (code) {
        this.sendKeyUp(code, flags);
      }
    };

    const onBlur = () => {
      this.releaseAllHeldKeys();
    };

    const onPaste = (ev) => {
      if (!this.canSendInput()) return;
      const pasted = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
      if (pasted) {
        ev.preventDefault();
        this.sendText(pasted);
      }
    };

    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointerup', onPointerUp);
    canvasEl.addEventListener('contextmenu', onContextMenu);
    canvasEl.addEventListener('wheel', onWheel, { passive: false });
    canvasEl.addEventListener('keydown', onKeyDown);
    canvasEl.addEventListener('keyup', onKeyUp);
    canvasEl.addEventListener('blur', onBlur);
    canvasEl.addEventListener('paste', onPaste);

    const dispose = () => {
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointerup', onPointerUp);
      canvasEl.removeEventListener('contextmenu', onContextMenu);
      canvasEl.removeEventListener('wheel', onWheel);
      canvasEl.removeEventListener('keydown', onKeyDown);
      canvasEl.removeEventListener('keyup', onKeyUp);
      canvasEl.removeEventListener('blur', onBlur);
      canvasEl.removeEventListener('paste', onPaste);
    };
    this._canvasDisposer = dispose;
    return dispose;
  }

  detachCanvasInput() {
    if (this._canvasDisposer) {
      this._canvasDisposer();
      this._canvasDisposer = null;
    }
  }

  _cleanupConnectionState() {
    this._stopMetricsLoop();
    this.releaseAllHeldKeys();
    this.connected = false;
    this.connecting = false;
    this.ws = null;
    this.sessionId = '';
    this.viewOnly = false;
    this.hasControl = false;
    this.controllerId = null;
    this.viewers = 0;

    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', this._windowBlurHandler);
    }

    for (const [, pending] of this._pendingSftp.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Gateway disconnected.'));
    }
    this._pendingSftp.clear();
  }

  disconnect(sendCloseFrame = true) {
    const ws = this.ws;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        this.releaseAllHeldKeys();
        if (sendCloseFrame) {
          this.sendControl({ type: 'close' });
        }
      }
      this._cleanupConnectionState();
      try {
        ws.close(1000, 'Client disconnected');
      } catch {
        // Ignore close error
      }
    } else {
      this._cleanupConnectionState();
    }
  }
}
