/**
 * JalaDesk Self-Hosted Web Gateway — JSR1 Binary WebSocket Wire Protocol
 *
 * Inspired by vercel-labs/screen-relay's NSL1 binary framing & closed-loop
 * viewer-wait-subtracted ACK congestion control, adapted for JalaDesk's
 * multi-protocol (RDP / VNC / SSH / SFTP) Web Gateway.
 *
 * All multi-byte integers are big-endian (network byte order).
 */

export const JSR1_MAGIC_0 = 0x4a; // 'J'
export const JSR1_MAGIC_1 = 0x53; // 'S'
export const JSR1_MAGIC_2 = 0x52; // 'R'
export const JSR1_MAGIC_3 = 0x31; // '1'
export const JSR1_MAGIC_U32 = 0x4a535231;

export const JSR1_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB
export const JSR1_MAX_UNICODE_BYTES = 4096;
export const JSR1_FRAME_TILE_HEADER_BYTES = 35;
export const JSR1_FRAME_ACK_BYTES = 13;
export const JSR1_INPUT_HEADER_BYTES = 18;
export const JSR1_CONTROL_HEADER_BYTES = 5;

export const Jsr1MsgType = {
  FRAME_TILE: 0x01,
  FRAME_ACK: 0x02,
  INPUT_EVENT: 0x03,
  CONTROL_JSON: 0x04,
} as const;
export type Jsr1MsgTypeValue = (typeof Jsr1MsgType)[keyof typeof Jsr1MsgType];

export const Jsr1TileCodec = {
  PNG: 1,
  RAW_DEFLATE: 2,
} as const;
export type Jsr1TileCodecValue = (typeof Jsr1TileCodec)[keyof typeof Jsr1TileCodec];

export const Jsr1TileFlags = {
  NONE: 0x00,
  KEYFRAME: 0x01,
} as const;

export const Jsr1InputKind = {
  MOVE: 1,
  DOWN: 2,
  UP: 3,
  WHEEL: 4,
  KEY_DOWN: 5,
  KEY_UP: 6,
  UNICODE: 7,
} as const;
export type Jsr1InputKindValue = (typeof Jsr1InputKind)[keyof typeof Jsr1InputKind];

export interface Jsr1FrameTile {
  seq: number;
  sentUs: bigint;
  x: number;
  y: number;
  w: number;
  h: number;
  fullW: number;
  fullH: number;
  codec: Jsr1TileCodecValue;
  flags: number;
  payload: Uint8Array;
}

export interface Jsr1FrameAck {
  seq: number;
  viewerWaitUs: number;
}

export interface Jsr1InputEvent {
  kind: Jsr1InputKindValue;
  normX: number; // 0..65535
  normY: number; // 0..65535
  codeOrDelta: number; // signed int32
  flags: number; // uint16
  text?: string;
}

export type Jsr1ControlType =
  | 'open'
  | 'opened'
  | 'resize'
  | 'takeControl'
  | 'releaseControl'
  | 'controlState'
  | 'sshData'
  | 'sshResize'
  | 'sftpReq'
  | 'sftpRes'
  | 'stats'
  | 'close'
  | 'error';

export interface Jsr1ControlMessage {
  type: Jsr1ControlType | string;
  [key: string]: unknown;
}

export type Jsr1DecodedMessage =
  | { type: typeof Jsr1MsgType.FRAME_TILE; tile: Jsr1FrameTile }
  | { type: typeof Jsr1MsgType.FRAME_ACK; ack: Jsr1FrameAck }
  | { type: typeof Jsr1MsgType.INPUT_EVENT; input: Jsr1InputEvent }
  | { type: typeof Jsr1MsgType.CONTROL_JSON; control: Jsr1ControlMessage };

export function nowMicros(): bigint {
  return process.hrtime.bigint() / 1000n;
}

function writeMagic(buf: Buffer, msgType: Jsr1MsgTypeValue): void {
  buf[0] = JSR1_MAGIC_0;
  buf[1] = JSR1_MAGIC_1;
  buf[2] = JSR1_MAGIC_2;
  buf[3] = JSR1_MAGIC_3;
  buf[4] = msgType;
}

function clampU16(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 0xffff) return 0xffff;
  return Math.round(v);
}

function assertU16(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new RangeError(`JSR1 ${name} must be uint16, got ${v}`);
  }
}

function assertU32(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new RangeError(`JSR1 ${name} must be uint32, got ${v}`);
  }
}

export function encodeFrameTile(tile: Jsr1FrameTile): Buffer {
  assertU32('seq', tile.seq);
  if (tile.sentUs < 0n || tile.sentUs > 0xffffffffffffffffn) {
    throw new RangeError('JSR1 sentUs must be uint64');
  }
  assertU16('x', tile.x);
  assertU16('y', tile.y);
  assertU16('w', tile.w);
  assertU16('h', tile.h);
  assertU16('fullW', tile.fullW);
  assertU16('fullH', tile.fullH);
  if (tile.codec !== Jsr1TileCodec.PNG && tile.codec !== Jsr1TileCodec.RAW_DEFLATE) {
    throw new RangeError(`Unsupported JSR1 tile codec: ${tile.codec}`);
  }
  if (tile.payload.byteLength > JSR1_MAX_PAYLOAD_BYTES) {
    throw new RangeError(`JSR1 tile payload exceeds ${JSR1_MAX_PAYLOAD_BYTES} bytes`);
  }

  const buf = Buffer.allocUnsafe(JSR1_FRAME_TILE_HEADER_BYTES + tile.payload.byteLength);
  writeMagic(buf, Jsr1MsgType.FRAME_TILE);
  buf.writeUInt32BE(tile.seq, 5);
  buf.writeBigUInt64BE(tile.sentUs, 9);
  buf.writeUInt16BE(tile.x, 17);
  buf.writeUInt16BE(tile.y, 19);
  buf.writeUInt16BE(tile.w, 21);
  buf.writeUInt16BE(tile.h, 23);
  buf.writeUInt16BE(tile.fullW, 25);
  buf.writeUInt16BE(tile.fullH, 27);
  buf[29] = tile.codec & 0xff;
  buf[30] = tile.flags & 0xff;
  buf.writeUInt32BE(tile.payload.byteLength, 31);
  buf.set(tile.payload, JSR1_FRAME_TILE_HEADER_BYTES);
  return buf;
}

export function encodeFrameAck(ack: Jsr1FrameAck): Buffer {
  assertU32('seq', ack.seq);
  assertU32('viewerWaitUs', ack.viewerWaitUs);
  const buf = Buffer.allocUnsafe(JSR1_FRAME_ACK_BYTES);
  writeMagic(buf, Jsr1MsgType.FRAME_ACK);
  buf.writeUInt32BE(ack.seq, 5);
  buf.writeUInt32BE(ack.viewerWaitUs, 9);
  return buf;
}

export function encodeInputEvent(ev: Jsr1InputEvent): Buffer {
  if (!Number.isInteger(ev.kind) || ev.kind < 1 || ev.kind > 7) {
    throw new RangeError(`Invalid JSR1 input kind: ${ev.kind}`);
  }
  const textBytes = ev.text ? Buffer.from(ev.text, 'utf8') : Buffer.alloc(0);
  if (textBytes.byteLength > JSR1_MAX_UNICODE_BYTES) {
    throw new RangeError(`JSR1 input text exceeds ${JSR1_MAX_UNICODE_BYTES} bytes`);
  }
  const buf = Buffer.allocUnsafe(JSR1_INPUT_HEADER_BYTES + textBytes.byteLength);
  writeMagic(buf, Jsr1MsgType.INPUT_EVENT);
  buf[5] = ev.kind;
  buf.writeUInt16BE(clampU16(ev.normX), 6);
  buf.writeUInt16BE(clampU16(ev.normY), 8);
  const codeOrDelta = Number.isFinite(ev.codeOrDelta) ? Math.trunc(ev.codeOrDelta) : 0;
  buf.writeInt32BE(Math.max(-0x80000000, Math.min(0x7fffffff, codeOrDelta)), 10);
  buf.writeUInt16BE(clampU16(ev.flags), 14);
  buf.writeUInt16BE(textBytes.byteLength, 16);
  if (textBytes.byteLength > 0) {
    textBytes.copy(buf, JSR1_INPUT_HEADER_BYTES);
  }
  return buf;
}

export function encodeControlJson(msg: Jsr1ControlMessage): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(msg), 'utf8');
  if (jsonBytes.byteLength > JSR1_MAX_PAYLOAD_BYTES) {
    throw new RangeError(`JSR1 control payload exceeds ${JSR1_MAX_PAYLOAD_BYTES} bytes`);
  }
  const buf = Buffer.allocUnsafe(JSR1_CONTROL_HEADER_BYTES + jsonBytes.byteLength);
  writeMagic(buf, Jsr1MsgType.CONTROL_JSON);
  jsonBytes.copy(buf, JSR1_CONTROL_HEADER_BYTES);
  return buf;
}

export function decodeJsr1Message(raw: Uint8Array): Jsr1DecodedMessage {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.byteLength < 5) {
    throw new Error('JSR1 frame too short');
  }
  if (
    buf[0] !== JSR1_MAGIC_0 ||
    buf[1] !== JSR1_MAGIC_1 ||
    buf[2] !== JSR1_MAGIC_2 ||
    buf[3] !== JSR1_MAGIC_3
  ) {
    throw new Error('JSR1 invalid magic header');
  }

  const msgType = buf[4];
  switch (msgType) {
    case Jsr1MsgType.FRAME_TILE: {
      if (buf.byteLength < JSR1_FRAME_TILE_HEADER_BYTES) {
        throw new Error('JSR1 FRAME_TILE header truncated');
      }
      const seq = buf.readUInt32BE(5);
      const sentUs = buf.readBigUInt64BE(9);
      const x = buf.readUInt16BE(17);
      const y = buf.readUInt16BE(19);
      const w = buf.readUInt16BE(21);
      const h = buf.readUInt16BE(23);
      const fullW = buf.readUInt16BE(25);
      const fullH = buf.readUInt16BE(27);
      const codec = buf[29];
      const flags = buf[30];
      const payloadLen = buf.readUInt32BE(31);
      if (codec !== Jsr1TileCodec.PNG && codec !== Jsr1TileCodec.RAW_DEFLATE) {
        throw new Error(`JSR1 unsupported tile codec: ${codec}`);
      }
      if (payloadLen > JSR1_MAX_PAYLOAD_BYTES) {
        throw new Error('JSR1 tile payload exceeds max limit');
      }
      if (buf.byteLength !== JSR1_FRAME_TILE_HEADER_BYTES + payloadLen) {
        throw new Error(
          `JSR1 FRAME_TILE length mismatch: expected ${JSR1_FRAME_TILE_HEADER_BYTES + payloadLen}, got ${buf.byteLength}`,
        );
      }
      // Zero-copy subarray slice over underlying buffer
      const payload = buf.subarray(JSR1_FRAME_TILE_HEADER_BYTES, JSR1_FRAME_TILE_HEADER_BYTES + payloadLen);
      return {
        type: Jsr1MsgType.FRAME_TILE,
        tile: { seq, sentUs, x, y, w, h, fullW, fullH, codec, flags, payload },
      };
    }

    case Jsr1MsgType.FRAME_ACK: {
      if (buf.byteLength !== JSR1_FRAME_ACK_BYTES) {
        throw new Error(`JSR1 FRAME_ACK must be ${JSR1_FRAME_ACK_BYTES} bytes, got ${buf.byteLength}`);
      }
      return {
        type: Jsr1MsgType.FRAME_ACK,
        ack: {
          seq: buf.readUInt32BE(5),
          viewerWaitUs: buf.readUInt32BE(9),
        },
      };
    }

    case Jsr1MsgType.INPUT_EVENT: {
      if (buf.byteLength < JSR1_INPUT_HEADER_BYTES) {
        throw new Error('JSR1 INPUT_EVENT header truncated');
      }
      const kind = buf[5];
      if (kind < 1 || kind > 7) {
        throw new Error(`JSR1 invalid input kind: ${kind}`);
      }
      const normX = buf.readUInt16BE(6);
      const normY = buf.readUInt16BE(8);
      const codeOrDelta = buf.readInt32BE(10);
      const flags = buf.readUInt16BE(14);
      const textLen = buf.readUInt16BE(16);
      if (textLen > JSR1_MAX_UNICODE_BYTES) {
        throw new Error('JSR1 input text exceeds max limit');
      }
      if (buf.byteLength !== JSR1_INPUT_HEADER_BYTES + textLen) {
        throw new Error('JSR1 INPUT_EVENT length mismatch');
      }
      const text =
        textLen > 0
          ? buf.subarray(JSR1_INPUT_HEADER_BYTES, JSR1_INPUT_HEADER_BYTES + textLen).toString('utf8')
          : undefined;
      return {
        type: Jsr1MsgType.INPUT_EVENT,
        input: {
          kind: kind as Jsr1InputKindValue,
          normX,
          normY,
          codeOrDelta,
          flags,
          ...(text !== undefined ? { text } : {}),
        },
      };
    }

    case Jsr1MsgType.CONTROL_JSON: {
      if (buf.byteLength - JSR1_CONTROL_HEADER_BYTES > JSR1_MAX_PAYLOAD_BYTES) {
        throw new Error('JSR1 CONTROL_JSON exceeds max limit');
      }
      const parsed: unknown = JSON.parse(buf.subarray(JSR1_CONTROL_HEADER_BYTES).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSR1 CONTROL_JSON must be a JSON object');
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record.type !== 'string' || !record.type.length) {
        throw new Error('JSR1 CONTROL_JSON missing string "type"');
      }
      return {
        type: Jsr1MsgType.CONTROL_JSON,
        control: record as Jsr1ControlMessage,
      };
    }

    default:
      throw new Error(`JSR1 unknown message type: 0x${msgType.toString(16)}`);
  }
}

export interface CongestionControllerOptions {
  minFps?: number;
  maxFps?: number;
  initialFps?: number;
  maxInFlight?: number;
  targetNetworkRttUs?: number;
  highNetworkRttUs?: number;
  inFlightTimeoutUs?: bigint;
  nowUs?: () => bigint;
}

export interface AckEvaluation {
  matched: boolean;
  seq: number;
  totalRttUs: number;
  viewerWaitUs: number;
  networkRttUs: number;
  targetFps: number;
  inFlightCount: number;
  paused: boolean;
}

export interface CongestionStats {
  targetFps: number;
  inFlightCount: number;
  maxInFlight: number;
  paused: boolean;
  smoothedNetworkRttUs: number;
  lastNetworkRttUs: number;
  lastTotalRttUs: number;
  lastViewerWaitUs: number;
  ackedCount: number;
  droppedStaleCount: number;
}

/**
 * Closed-loop ACK congestion controller.
 * Subtracts browser decode/paint wait (`viewerWaitUs`) from end-to-end RTT so
 * local browser paint slowness is never misclassified as network congestion.
 * Pauses capture whenever in-flight unacknowledged frames reach `maxInFlight`.
 */
export class ClosedLoopCongestionController {
  readonly minFps: number;
  readonly maxFps: number;
  readonly maxInFlight: number;
  readonly targetNetworkRttUs: number;
  readonly highNetworkRttUs: number;
  readonly inFlightTimeoutUs: bigint;
  private readonly clock: () => bigint;

  readonly inFlightSeqs = new Map<number, bigint>();
  private targetFps: number;
  private smoothedNetworkRttUs = 0;
  private lastNetworkRttUs = 0;
  private lastTotalRttUs = 0;
  private lastViewerWaitUs = 0;
  private ackedCount = 0;
  private droppedStaleCount = 0;

  constructor(options: CongestionControllerOptions = {}) {
    this.minFps = Math.max(1, Math.floor(options.minFps ?? 5));
    this.maxFps = Math.max(this.minFps, Math.floor(options.maxFps ?? 60));
    this.targetFps = Math.max(this.minFps, Math.min(this.maxFps, Math.floor(options.initialFps ?? 30)));
    this.maxInFlight = Math.max(1, Math.floor(options.maxInFlight ?? 3));
    this.targetNetworkRttUs = Math.max(5_000, Math.floor(options.targetNetworkRttUs ?? 45_000));
    this.highNetworkRttUs = Math.max(this.targetNetworkRttUs + 10_000, Math.floor(options.highNetworkRttUs ?? 120_000));
    this.inFlightTimeoutUs = options.inFlightTimeoutUs ?? 5_000_000n;
    this.clock = options.nowUs ?? nowMicros;
  }

  private evictStale(now: bigint): void {
    for (const [seq, sentUs] of this.inFlightSeqs) {
      if (now - sentUs > this.inFlightTimeoutUs) {
        this.inFlightSeqs.delete(seq);
        this.droppedStaleCount += 1;
      }
    }
  }

  canSend(now?: bigint): boolean {
    const t = now ?? this.clock();
    this.evictStale(t);
    return this.inFlightSeqs.size < this.maxInFlight;
  }

  isPaused(now?: bigint): boolean {
    return !this.canSend(now);
  }

  onFrameSent(seq: number, sentUs?: bigint): void {
    const t = sentUs ?? this.clock();
    this.evictStale(t);
    this.inFlightSeqs.set(seq, t);
  }

  onFrameAck(seq: number, viewerWaitUs: number, receivedUs?: bigint): AckEvaluation {
    const now = receivedUs ?? this.clock();
    const sentUs = this.inFlightSeqs.get(seq);
    if (sentUs === undefined) {
      return {
        matched: false,
        seq,
        totalRttUs: 0,
        viewerWaitUs: Math.max(0, Math.floor(viewerWaitUs)),
        networkRttUs: 0,
        targetFps: this.targetFps,
        inFlightCount: this.inFlightSeqs.size,
        paused: this.inFlightSeqs.size >= this.maxInFlight,
      };
    }

    this.inFlightSeqs.delete(seq);
    const safeViewerWait = Math.max(0, Math.floor(viewerWaitUs));
    const totalRttUs = now >= sentUs ? Number(now - sentUs) : 0;
    const networkRttUs = Math.max(0, totalRttUs - safeViewerWait);

    this.lastTotalRttUs = totalRttUs;
    this.lastViewerWaitUs = safeViewerWait;
    this.lastNetworkRttUs = networkRttUs;
    this.smoothedNetworkRttUs =
      this.ackedCount === 0
        ? networkRttUs
        : Math.round(this.smoothedNetworkRttUs * 0.75 + networkRttUs * 0.25);
    this.ackedCount += 1;

    if (networkRttUs >= this.highNetworkRttUs) {
      // Significant network queueing -> multiplicative decrease
      this.targetFps = Math.max(this.minFps, Math.floor(this.targetFps * 0.75));
    } else if (networkRttUs > this.targetNetworkRttUs) {
      // Moderate latency -> gentle backoff
      this.targetFps = Math.max(this.minFps, this.targetFps - 2);
    } else if (networkRttUs < this.targetNetworkRttUs * 0.6) {
      // Healthy link -> ramp up smoothly
      this.targetFps = Math.min(this.maxFps, this.targetFps + 3);
    } else {
      this.targetFps = Math.min(this.maxFps, this.targetFps + 1);
    }

    return {
      matched: true,
      seq,
      totalRttUs,
      viewerWaitUs: safeViewerWait,
      networkRttUs,
      targetFps: this.targetFps,
      inFlightCount: this.inFlightSeqs.size,
      paused: this.inFlightSeqs.size >= this.maxInFlight,
    };
  }

  getTargetFps(): number {
    return this.targetFps;
  }

  getFrameIntervalMs(): number {
    return Math.max(16, Math.round(1000 / this.targetFps));
  }

  getStats(now?: bigint): CongestionStats {
    this.evictStale(now ?? this.clock());
    return {
      targetFps: this.targetFps,
      inFlightCount: this.inFlightSeqs.size,
      maxInFlight: this.maxInFlight,
      paused: this.inFlightSeqs.size >= this.maxInFlight,
      smoothedNetworkRttUs: this.smoothedNetworkRttUs,
      lastNetworkRttUs: this.lastNetworkRttUs,
      lastTotalRttUs: this.lastTotalRttUs,
      lastViewerWaitUs: this.lastViewerWaitUs,
      ackedCount: this.ackedCount,
      droppedStaleCount: this.droppedStaleCount,
    };
  }

  reset(initialFps?: number): void {
    this.inFlightSeqs.clear();
    if (initialFps !== undefined) {
      this.targetFps = Math.max(this.minFps, Math.min(this.maxFps, Math.floor(initialFps)));
    }
    this.smoothedNetworkRttUs = 0;
    this.lastNetworkRttUs = 0;
    this.lastTotalRttUs = 0;
    this.lastViewerWaitUs = 0;
    this.ackedCount = 0;
    this.droppedStaleCount = 0;
  }
}
