/**
 * JalaDesk Self-Hosted Web Gateway — Pure-Node RFC 6455 WebSocket Server
 *
 * Zero external runtime dependencies! Implements RFC 6455 upgrade handshake
 * (SHA-1 GUID accept + `Sec-WebSocket-Protocol` negotiation), full client frame
 * unmasking, continuation reassembly, binary/text/ping/pong/close control frames,
 * 8 MiB max frame limit, and write backpressure protection.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MiB
export const WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024; // 16 MiB

export const WsOpcode = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface WsConnectionCallbacks {
  onBinary?: (payload: Buffer) => void;
  onText?: (text: string) => void;
  onPong?: (payload: Buffer) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
}

export interface WsServerOptions {
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
}

export function computeWebSocketAccept(key: string): string {
  return createHash('sha1').update(`${key.trim()}${WS_GUID}`, 'utf8').digest('base64');
}

export function rejectUpgrade(socket: Duplex, statusCode: number, reason: string): void {
  const safeReason = reason.replace(/[\r\n]+/g, ' ').slice(0, 128);
  const body = JSON.stringify({ ok: false, error: safeReason });
  const statusText =
    statusCode === 400
      ? 'Bad Request'
      : statusCode === 401
        ? 'Unauthorized'
        : statusCode === 403
          ? 'Forbidden'
          : statusCode === 404
            ? 'Not Found'
            : 'Upgrade Required';
  try {
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        `Content-Type: application/json; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n` +
        `Cache-Control: no-store\r\n` +
        `\r\n` +
        body,
      () => {
        socket.destroy();
      },
    );
    const killTimer = setTimeout(() => socket.destroy(), 250);
    killTimer.unref();
  } catch {
    socket.destroy();
  }
}

export function encodeWsServerFrame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.byteLength;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) {
    headerLen = 4;
  } else if (len > 0xffff) {
    headerLen = 10;
  }

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f); // FIN = 1, RSV = 0
  if (len < 126) {
    frame[1] = len;
  } else if (len <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  if (len > 0) {
    frame.set(payload, headerLen);
  }
  return frame;
}

export class PureWsConnection {
  readonly socket: Duplex;
  readonly subprotocol: string | null;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly callbacks: WsConnectionCallbacks = {};

  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragOpcode: number | null = null;
  private fragChunks: Buffer[] = [];
  private fragBytes = 0;
  private closed = false;
  private closeSent = false;

  constructor(socket: Duplex, subprotocol: string | null, options: WsServerOptions = {}) {
    this.socket = socket;
    this.subprotocol = subprotocol;
    this.maxFrameBytes = options.maxFrameBytes ?? WS_MAX_FRAME_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? WS_MAX_BUFFERED_BYTES;

    this.socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.socket.on('error', (err: Error) => {
      this.callbacks.onError?.(err);
      this.finishClose(1006, 'socket error');
    });
    this.socket.on('close', () => {
      this.finishClose(1006, 'connection closed');
    });
    this.socket.on('end', () => {
      this.finishClose(1000, 'eof');
    });
  }

  setCallbacks(callbacks: WsConnectionCallbacks): void {
    Object.assign(this.callbacks, callbacks);
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  hasBackpressure(): boolean {
    return this.socket.writableLength >= this.maxBufferedBytes;
  }

  sendBinary(payload: Uint8Array): boolean {
    if (!this.isOpen || this.hasBackpressure()) return false;
    try {
      this.socket.write(encodeWsServerFrame(WsOpcode.BINARY, payload));
      return true;
    } catch {
      return false;
    }
  }

  sendText(text: string): boolean {
    if (!this.isOpen || this.hasBackpressure()) return false;
    try {
      this.socket.write(encodeWsServerFrame(WsOpcode.TEXT, Buffer.from(text, 'utf8')));
      return true;
    } catch {
      return false;
    }
  }

  ping(payload: Uint8Array = Buffer.alloc(0)): boolean {
    if (!this.isOpen) return false;
    try {
      this.socket.write(encodeWsServerFrame(WsOpcode.PING, payload.subarray(0, 125)));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    if (!this.closeSent && !this.socket.destroyed) {
      this.closeSent = true;
      const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123);
      const body = Buffer.allocUnsafe(2 + reasonBuf.byteLength);
      body.writeUInt16BE(code, 0);
      reasonBuf.copy(body, 2);
      try {
        this.socket.write(encodeWsServerFrame(WsOpcode.CLOSE, body));
      } catch {
        // Ignore close write errors
      }
    }
    this.finishClose(code, reason);
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }

  terminate(): void {
    this.finishClose(1006, 'terminated');
    this.socket.destroy();
  }

  private finishClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragChunks = [];
    this.fragBytes = 0;
    this.callbacks.onClose?.(code, reason);
  }

  /**
   * Feeds any leftover bytes captured in the HTTP upgrade `head` buffer.
   */
  feedInitialHead(head: Buffer): void {
    if (head.byteLength > 0) {
      this.handleData(head);
    }
  }

  private handleData(chunk: Buffer): void {
    if (this.closed || chunk.byteLength === 0) return;
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (!this.closed && this.buffer.byteLength >= 2) {
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;

      if (rsv !== 0) {
        this.close(1002, 'non-zero RSV bits');
        return;
      }
      if (!masked) {
        // RFC 6455 §5.1: all client-to-server frames MUST be masked
        this.close(1002, 'unmasked client frame');
        return;
      }

      let offset = 2;
      if (payloadLen === 126) {
        if (this.buffer.byteLength < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.byteLength < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(this.maxFrameBytes)) {
          this.close(1009, 'frame exceeds max payload limit');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > this.maxFrameBytes) {
        this.close(1009, 'frame exceeds max payload limit');
        return;
      }

      const isControl = (opcode & 0x08) !== 0;
      if (isControl && (!fin || payloadLen > 125)) {
        this.close(1002, 'invalid control frame');
        return;
      }

      const totalLen = offset + 4 + payloadLen;
      if (this.buffer.byteLength < totalLen) {
        return; // Wait for more TCP bytes
      }

      const maskKey0 = this.buffer[offset]!;
      const maskKey1 = this.buffer[offset + 1]!;
      const maskKey2 = this.buffer[offset + 2]!;
      const maskKey3 = this.buffer[offset + 3]!;
      const payloadStart = offset + 4;
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        const m = (i & 3) === 0 ? maskKey0 : (i & 3) === 1 ? maskKey1 : (i & 3) === 2 ? maskKey2 : maskKey3;
        payload[i] = this.buffer[payloadStart + i]! ^ m;
      }

      this.buffer =
        totalLen === this.buffer.byteLength ? Buffer.alloc(0) : this.buffer.subarray(totalLen);

      this.dispatchFrame(fin, opcode, payload);
    }
  }

  private dispatchFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case WsOpcode.PING: {
        if (this.isOpen) {
          try {
            this.socket.write(encodeWsServerFrame(WsOpcode.PONG, payload));
          } catch {
            // ignore
          }
        }
        return;
      }
      case WsOpcode.PONG: {
        this.callbacks.onPong?.(payload);
        return;
      }
      case WsOpcode.CLOSE: {
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.byteLength > 2 ? payload.subarray(2).toString('utf8') : '';
        this.close(code, reason);
        return;
      }
      case WsOpcode.BINARY:
      case WsOpcode.TEXT: {
        if (this.fragOpcode !== null) {
          this.close(1002, 'unexpected data frame during fragmentation');
          return;
        }
        if (fin) {
          if (opcode === WsOpcode.BINARY) {
            this.callbacks.onBinary?.(payload);
          } else {
            this.callbacks.onText?.(payload.toString('utf8'));
          }
        } else {
          this.fragOpcode = opcode;
          this.fragChunks = [payload];
          this.fragBytes = payload.byteLength;
        }
        return;
      }
      case WsOpcode.CONTINUATION: {
        if (this.fragOpcode === null) {
          this.close(1002, 'unexpected continuation frame');
          return;
        }
        this.fragBytes += payload.byteLength;
        if (this.fragBytes > this.maxFrameBytes) {
          this.close(1009, 'fragmented message exceeds max payload limit');
          return;
        }
        this.fragChunks.push(payload);
        if (fin) {
          const assembled = Buffer.concat(this.fragChunks);
          const op = this.fragOpcode;
          this.fragOpcode = null;
          this.fragChunks = [];
          this.fragBytes = 0;
          if (op === WsOpcode.BINARY) {
            this.callbacks.onBinary?.(assembled);
          } else {
            this.callbacks.onText?.(assembled.toString('utf8'));
          }
        }
        return;
      }
      default: {
        this.close(1002, `unsupported opcode 0x${opcode.toString(16)}`);
      }
    }
  }
}

/**
 * Completes an RFC 6455 HTTP -> WebSocket upgrade handshake on `socket`.
 */
export function acceptWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { subprotocol?: string | null; maxFrameBytes?: number; maxBufferedBytes?: number } = {},
): PureWsConnection | null {
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const version = String(req.headers['sec-websocket-version'] ?? '').trim();
  const key = req.headers['sec-websocket-key'];

  if (upgrade !== 'websocket' || version !== '13' || typeof key !== 'string' || key.trim().length < 16) {
    rejectUpgrade(socket, 400, 'Invalid WebSocket upgrade headers');
    return null;
  }

  const acceptKey = computeWebSocketAccept(key);
  const subprotocol = options.subprotocol?.trim() || null;

  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
  ];
  if (subprotocol) {
    // Reject CR/LF header injection in subprotocol
    if (/[\r\n]/.test(subprotocol)) {
      rejectUpgrade(socket, 400, 'Invalid Sec-WebSocket-Protocol');
      return null;
    }
    lines.push(`Sec-WebSocket-Protocol: ${subprotocol}`);
  }
  lines.push('', '');

  try {
    socket.write(lines.join('\r\n'));
  } catch {
    socket.destroy();
    return null;
  }

  const conn = new PureWsConnection(socket, subprotocol, {
    maxFrameBytes: options.maxFrameBytes,
    maxBufferedBytes: options.maxBufferedBytes,
  });
  conn.feedInitialHead(head);
  return conn;
}
