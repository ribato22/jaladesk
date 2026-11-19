/**
 * JalaDesk Self-Hosted Web Gateway — Dirty-Rect Differ & Pure-Node PNG Tile Encoder
 *
 * Partitions full RGBA desktop frames into 64x64 tiles, detects exact changed
 * bounding rectangles (returning 0 tiles on identical frames for idle zero-frame
 * pause), and encodes each dirty-rect as a standard RFC 2083 PNG directly
 * decodable via browser `createImageBitmap(new Blob([png], { type: 'image/png' }))`
 * with ZERO native or third-party image dependencies.
 */

import { deflateSync } from 'node:zlib';
import { Jsr1TileCodec, Jsr1TileFlags, type Jsr1TileCodecValue } from './wire-protocol.js';

export const DIRTY_TILE_SIZE = 64;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND_CHUNK = Buffer.from([
  0x00, 0x00, 0x00, 0x00, // length 0
  0x49, 0x45, 0x4e, 0x44, // 'IEND'
  0xae, 0x42, 0x60, 0x82, // CRC32('IEND')
]);

// Precomputed IEEE 802.3 CRC-32 lookup table for PNG chunks
const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

export function pngCrc32(data: Uint8Array, offset = 0, length = data.byteLength - offset): number {
  let c = 0xffffffff;
  const end = offset + length;
  for (let i = offset; i < end; i++) {
    c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(typeAscii: string, payload: Uint8Array): Buffer {
  const chunk = Buffer.allocUnsafe(12 + payload.byteLength);
  chunk.writeUInt32BE(payload.byteLength, 0);
  chunk[4] = typeAscii.charCodeAt(0);
  chunk[5] = typeAscii.charCodeAt(1);
  chunk[6] = typeAscii.charCodeAt(2);
  chunk[7] = typeAscii.charCodeAt(3);
  if (payload.byteLength > 0) {
    chunk.set(payload, 8);
  }
  const crc = pngCrc32(chunk, 4, 4 + payload.byteLength);
  chunk.writeUInt32BE(crc, 8 + payload.byteLength);
  return chunk;
}

export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EncodedTile {
  x: number;
  y: number;
  w: number;
  h: number;
  fullW: number;
  fullH: number;
  codec: Jsr1TileCodecValue;
  flags: number;
  payload: Buffer;
}

/**
 * Encodes a rectangular region (x, y, w, h) from a full RGBA framebuffer into a
 * valid standard PNG (8-bit RGBA, PNG Sub scanline filter type 1 for strong
 * compression on flat UI regions & crisp text).
 */
export function encodeRgbaRectToPng(
  rgba: Uint8Array,
  fullW: number,
  fullH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  compressionLevel = 4,
): Buffer {
  if (
    !Number.isInteger(fullW) ||
    !Number.isInteger(fullH) ||
    fullW < 1 ||
    fullH < 1 ||
    rgba.byteLength < fullW * fullH * 4
  ) {
    throw new RangeError('Invalid RGBA framebuffer dimensions');
  }
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    x < 0 ||
    y < 0 ||
    w < 1 ||
    h < 1 ||
    x + w > fullW ||
    y + h > fullH
  ) {
    throw new RangeError(`Invalid dirty rect (${x},${y},${w},${h}) for ${fullW}x${fullH}`);
  }

  // Build PNG scanlines with filter type 1 (Sub):
  // For each pixel byte i >= 4 in a row, store (cur[i] - cur[i - 4]) & 0xff.
  const rowPixelBytes = w * 4;
  const stride = rowPixelBytes + 1;
  const rawScanlines = Buffer.allocUnsafe(stride * h);
  const fullRowBytes = fullW * 4;

  for (let row = 0; row < h; row++) {
    const dstRow = row * stride;
    const srcRow = (y + row) * fullRowBytes + x * 4;
    rawScanlines[dstRow] = 1; // Filter type 1 = Sub

    // First pixel (4 bytes) has no left neighbor
    rawScanlines[dstRow + 1] = rgba[srcRow]!;
    rawScanlines[dstRow + 2] = rgba[srcRow + 1]!;
    rawScanlines[dstRow + 3] = rgba[srcRow + 2]!;
    rawScanlines[dstRow + 4] = rgba[srcRow + 3]!;

    for (let i = 4; i < rowPixelBytes; i++) {
      rawScanlines[dstRow + 1 + i] = (rgba[srcRow + i]! - rgba[srcRow + i - 4]!) & 0xff;
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth = 8
  ihdr[9] = 6; // color type = 6 (Truecolor with alpha / RGBA)
  ihdr[10] = 0; // compression method = deflate
  ihdr[11] = 0; // filter method = standard
  ihdr[12] = 0; // interlace = none

  const idatPayload = deflateSync(rawScanlines, { level: compressionLevel });
  const ihdrChunk = makePngChunk('IHDR', ihdr);
  const idatChunk = makePngChunk('IDAT', idatPayload);

  return Buffer.concat([PNG_SIGNATURE, ihdrChunk, idatChunk, PNG_IEND_CHUNK]);
}

function tileDiffers(
  curr32: Uint32Array,
  prev32: Uint32Array,
  fullW: number,
  tx: number,
  ty: number,
  tw: number,
  th: number,
): boolean {
  for (let row = 0; row < th; row++) {
    const base = (ty + row) * fullW + tx;
    for (let col = 0; col < tw; col++) {
      if (curr32[base + col] !== prev32[base + col]) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compares two equal-sized RGBA framebuffers on a 64x64 tile grid and merges
 * adjacent changed tiles horizontally and vertically into minimal non-overlapping
 * dirty rectangles. Returns an empty array when frames are byte-identical.
 */
export function detectDirtyRects(
  currRgba: Uint8Array,
  prevRgba: Uint8Array | null,
  width: number,
  height: number,
  tileSize = DIRTY_TILE_SIZE,
): DirtyRect[] {
  const expectedBytes = width * height * 4;
  if (currRgba.byteLength < expectedBytes) {
    throw new RangeError(`Expected at least ${expectedBytes} RGBA bytes, got ${currRgba.byteLength}`);
  }
  if (!prevRgba || prevRgba.byteLength < expectedBytes) {
    return [{ x: 0, y: 0, w: width, h: height }];
  }

  // Fast 32-bit pixel comparison when aligned; fallback to byte loop if unaligned
  const aligned =
    currRgba.byteOffset % 4 === 0 &&
    prevRgba.byteOffset % 4 === 0 &&
    expectedBytes % 4 === 0;
  const curr32 = aligned
    ? new Uint32Array(currRgba.buffer, currRgba.byteOffset, width * height)
    : null;
  const prev32 = aligned
    ? new Uint32Array(prevRgba.buffer, prevRgba.byteOffset, width * height)
    : null;

  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const activeRuns = new Map<string, DirtyRect>();
  const finished: DirtyRect[] = [];

  for (let r = 0; r < rows; r++) {
    const ty = r * tileSize;
    const th = Math.min(tileSize, height - ty);
    const rowRuns: Array<{ x0: number; x1: number }> = [];
    let runStart = -1;

    for (let c = 0; c < cols; c++) {
      const tx = c * tileSize;
      const tw = Math.min(tileSize, width - tx);
      let dirty = false;

      if (curr32 && prev32) {
        dirty = tileDiffers(curr32, prev32, width, tx, ty, tw, th);
      } else {
        outer: for (let row = 0; row < th; row++) {
          const base = ((ty + row) * width + tx) * 4;
          const end = base + tw * 4;
          for (let i = base; i < end; i++) {
            if (currRgba[i] !== prevRgba[i]) {
              dirty = true;
              break outer;
            }
          }
        }
      }

      if (dirty) {
        if (runStart < 0) runStart = tx;
      } else if (runStart >= 0) {
        rowRuns.push({ x0: runStart, x1: tx });
        runStart = -1;
      }
    }

    if (runStart >= 0) {
      rowRuns.push({ x0: runStart, x1: width });
    }

    // Merge vertical spans sharing identical [x0, x1] bounds
    const nextActive = new Map<string, DirtyRect>();
    for (const run of rowRuns) {
      const key = `${run.x0}:${run.x1}`;
      const existing = activeRuns.get(key);
      if (existing) {
        existing.h += th;
        nextActive.set(key, existing);
        activeRuns.delete(key);
      } else {
        nextActive.set(key, { x: run.x0, y: ty, w: run.x1 - run.x0, h: th });
      }
    }
    for (const closed of activeRuns.values()) {
      finished.push(closed);
    }
    activeRuns.clear();
    for (const [k, v] of nextActive) {
      activeRuns.set(k, v);
    }
  }

  for (const remaining of activeRuns.values()) {
    finished.push(remaining);
  }
  return finished;
}

/**
 * Stateful per-session dirty-rect encoder maintaining the previous frame buffer.
 */
export class DirtyRectFrameEncoder {
  private prevRgba: Uint8Array | null = null;
  private prevWidth = 0;
  private prevHeight = 0;
  private readonly tileSize: number;
  private readonly compressionLevel: number;

  constructor(options: { tileSize?: number; compressionLevel?: number } = {}) {
    this.tileSize = Math.max(16, Math.floor(options.tileSize ?? DIRTY_TILE_SIZE));
    this.compressionLevel = Math.max(1, Math.min(9, Math.floor(options.compressionLevel ?? 4)));
  }

  reset(): void {
    this.prevRgba = null;
    this.prevWidth = 0;
    this.prevHeight = 0;
  }

  encodeFrame(
    rgba: Uint8Array,
    width: number,
    height: number,
    options: { forceKeyframe?: boolean } = {},
  ): EncodedTile[] {
    const byteLen = width * height * 4;
    if (rgba.byteLength < byteLen) {
      throw new RangeError(`Frame buffer too small: ${rgba.byteLength} < ${byteLen}`);
    }

    const isKeyframe =
      Boolean(options.forceKeyframe) ||
      this.prevRgba === null ||
      this.prevWidth !== width ||
      this.prevHeight !== height;

    const rects: DirtyRect[] = isKeyframe
      ? [{ x: 0, y: 0, w: width, h: height }]
      : detectDirtyRects(rgba, this.prevRgba, width, height, this.tileSize);

    // Zero changed rectangles -> idle zero-frame pause!
    if (rects.length === 0) {
      return [];
    }

    // Snapshot current frame into owned buffer so caller can safely reuse its buffer
    if (!this.prevRgba || this.prevRgba.byteLength !== byteLen) {
      this.prevRgba = new Uint8Array(byteLen);
    }
    this.prevRgba.set(rgba.subarray(0, byteLen));
    this.prevWidth = width;
    this.prevHeight = height;

    const flags = isKeyframe ? Jsr1TileFlags.KEYFRAME : Jsr1TileFlags.NONE;
    return rects.map((rect) => ({
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      fullW: width,
      fullH: height,
      codec: Jsr1TileCodec.PNG,
      flags,
      payload: encodeRgbaRectToPng(
        rgba,
        width,
        height,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        this.compressionLevel,
      ),
    }));
  }
}
