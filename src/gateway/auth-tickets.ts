/**
 * JalaDesk Self-Hosted Web Gateway — Auth, 6-Digit Pairing Codes & Single-Use WS Tickets
 *
 * Security model inspired by vercel-labs/screen-relay + screenrelay.com:
 * - 256-bit random hex session master token (never exposed on unauthenticated HTTP endpoints).
 * - Short-lived 6-digit numeric Pairing Code (5 min TTL, single-use, 5-attempt brute-force lockout).
 * - 60-second single-use WebSocket upgrade tickets (`POST /api/tickets` -> `Sec-WebSocket-Protocol: ticket.<TICKET>`),
 *   preventing bearer credentials from appearing in URLs, browser history, or reverse-proxy logs.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_PAIRING_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_PAIRING_MAX_ATTEMPTS = 5;
export const DEFAULT_TICKET_TTL_MS = 60 * 1000; // 60 seconds
export const DEFAULT_TOKEN_EXPIRES_SEC = 12 * 60 * 60; // 12 hours advisory client TTL

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function generateMasterToken(): string {
  return randomBytes(32).toString('hex');
}

export interface PairingCodeOptions {
  ttlMs?: number;
  maxAttempts?: number;
  lockoutMs?: number;
  nowMs?: () => number;
  initialCode?: string;
}

export interface PairingCodeInfo {
  code: string;
  expiresAt: number;
  expiresInSec: number;
}

export type PairingExchangeResult =
  | { ok: true; token: string; expiresInSec: number }
  | { ok: false; status: 400 | 401 | 429; error: string; retryAfterSec?: number };

export class PairingCodeManager {
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly lockoutMs: number;
  private readonly clock: () => number;

  private activeCode: string | null = null;
  private expiresAt = 0;
  private failedAttempts = 0;
  private lockedUntil = 0;

  constructor(options: PairingCodeOptions = {}) {
    this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_PAIRING_TTL_MS));
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_PAIRING_MAX_ATTEMPTS));
    this.lockoutMs = Math.max(1_000, Math.floor(options.lockoutMs ?? DEFAULT_PAIRING_LOCKOUT_MS));
    this.clock = options.nowMs ?? Date.now;

    if (options.initialCode !== undefined) {
      const clean = options.initialCode.trim();
      if (!/^\d{6}$/.test(clean)) {
        throw new Error('Pairing code must be exactly 6 numeric digits');
      }
      this.activeCode = clean;
      this.expiresAt = this.clock() + this.ttlMs;
    } else {
      this.rotate();
    }
  }

  rotate(): PairingCodeInfo {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const now = this.clock();
    this.activeCode = code;
    this.expiresAt = now + this.ttlMs;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    return {
      code,
      expiresAt: this.expiresAt,
      expiresInSec: Math.ceil(this.ttlMs / 1000),
    };
  }

  /**
   * Returns current active pairing code for local CLI display only.
   * Never return this over any HTTP response!
   */
  getActiveCodeForCli(): PairingCodeInfo | null {
    const now = this.clock();
    if (!this.activeCode || now >= this.expiresAt) {
      return null;
    }
    return {
      code: this.activeCode,
      expiresAt: this.expiresAt,
      expiresInSec: Math.max(0, Math.ceil((this.expiresAt - now) / 1000)),
    };
  }

  isActive(): boolean {
    const now = this.clock();
    return Boolean(this.activeCode) && now < this.expiresAt && now >= this.lockedUntil;
  }

  isLocked(): boolean {
    return this.clock() < this.lockedUntil;
  }

  exchange(rawCode: unknown, tokenToGrant: string, tokenExpiresInSec = DEFAULT_TOKEN_EXPIRES_SEC): PairingExchangeResult {
    const now = this.clock();

    if (now < this.lockedUntil) {
      const retryAfterSec = Math.max(1, Math.ceil((this.lockedUntil - now) / 1000));
      return {
        ok: false,
        status: 429,
        error: 'Pairing code temporarily locked after too many failed attempts',
        retryAfterSec,
      };
    }

    // Reset attempt counter once prior lockout window elapsed
    if (this.lockedUntil > 0 && now >= this.lockedUntil) {
      this.lockedUntil = 0;
      this.failedAttempts = 0;
    }

    if (typeof rawCode !== 'string') {
      return { ok: false, status: 400, error: 'Pairing code must be a 6-digit string' };
    }
    // Allow optional whitespace or single dash like "123-456"
    const normalized = rawCode.trim().replace(/^(\d{3})[\s-](\d{3})$/, '$1$2');
    if (!/^\d{6}$/.test(normalized)) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= this.maxAttempts) {
        this.lockedUntil = now + this.lockoutMs;
        return {
          ok: false,
          status: 429,
          error: 'Too many failed pairing attempts',
          retryAfterSec: Math.ceil(this.lockoutMs / 1000),
        };
      }
      return { ok: false, status: 401, error: 'Invalid pairing code format' };
    }

    if (!this.activeCode || now >= this.expiresAt) {
      this.activeCode = null;
      return { ok: false, status: 401, error: 'Pairing code expired or already used' };
    }

    if (!constantTimeEqual(normalized, this.activeCode)) {
      this.failedAttempts += 1;
      if (this.failedAttempts >= this.maxAttempts) {
        this.lockedUntil = now + this.lockoutMs;
        return {
          ok: false,
          status: 429,
          error: 'Too many failed pairing attempts; pairing locked',
          retryAfterSec: Math.ceil(this.lockoutMs / 1000),
        };
      }
      return { ok: false, status: 401, error: 'Invalid pairing code' };
    }

    // Atomic single-use consumption
    this.activeCode = null;
    this.expiresAt = 0;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    return {
      ok: true,
      token: tokenToGrant,
      expiresInSec: tokenExpiresInSec,
    };
  }
}

export interface TicketOptions {
  ttlMs?: number;
  maxActiveTickets?: number;
  nowMs?: () => number;
}

export interface IssuedTicket {
  ticket: string;
  expiresAt: number;
  expiresInSec: number;
}

export interface TicketRecord {
  issuedAt: number;
  expiresAt: number;
  clientIp?: string;
}

export class TicketManager {
  private readonly ttlMs: number;
  private readonly maxActiveTickets: number;
  private readonly clock: () => number;
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(options: TicketOptions = {}) {
    this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_TICKET_TTL_MS));
    this.maxActiveTickets = Math.max(16, Math.floor(options.maxActiveTickets ?? 1024));
    this.clock = options.nowMs ?? Date.now;
  }

  private prune(now: number): void {
    for (const [key, rec] of this.tickets) {
      if (now >= rec.expiresAt) {
        this.tickets.delete(key);
      }
    }
  }

  issue(meta: { clientIp?: string } = {}): IssuedTicket {
    const now = this.clock();
    this.prune(now);

    // Evict oldest ticket if cap is reached
    if (this.tickets.size >= this.maxActiveTickets) {
      const oldestKey = this.tickets.keys().next().value;
      if (oldestKey !== undefined) {
        this.tickets.delete(oldestKey);
      }
    }

    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.tickets.set(ticket, {
      issuedAt: now,
      expiresAt,
      ...(meta.clientIp ? { clientIp: meta.clientIp } : {}),
    });

    return {
      ticket,
      expiresAt,
      expiresInSec: Math.ceil(this.ttlMs / 1000),
    };
  }

  /**
   * Atomically consumes a ticket. Replaying a consumed or expired ticket returns ok: false.
   */
  consume(ticket: string): { ok: true; record: TicketRecord } | { ok: false; reason: string } {
    const now = this.clock();
    this.prune(now);
    if (!ticket || ticket.length > 128) {
      return { ok: false, reason: 'invalid_ticket' };
    }
    const record = this.tickets.get(ticket);
    if (!record) {
      return { ok: false, reason: 'ticket_not_found_or_used' };
    }
    // Delete immediately before checking expiry so replay is impossible
    this.tickets.delete(ticket);
    if (now >= record.expiresAt) {
      return { ok: false, reason: 'ticket_expired' };
    }
    return { ok: true, record };
  }

  get activeCount(): number {
    this.prune(this.clock());
    return this.tickets.size;
  }
}

export interface GatewayAuthOptions {
  token?: string;
  pairing?: PairingCodeOptions;
  tickets?: TicketOptions;
  tokenExpiresInSec?: number;
}

export type UpgradeAuthResult =
  | { ok: true; method: 'ticket' | 'bearer'; subprotocol: string }
  | { ok: false; reason: string };

export class GatewayAuthManager {
  private readonly masterToken: string;
  readonly tokenExpiresInSec: number;
  readonly pairing: PairingCodeManager;
  readonly tickets: TicketManager;

  constructor(options: GatewayAuthOptions = {}) {
    const provided = options.token?.trim();
    this.masterToken = provided && provided.length > 0 ? provided : generateMasterToken();
    this.tokenExpiresInSec = Math.max(60, Math.floor(options.tokenExpiresInSec ?? DEFAULT_TOKEN_EXPIRES_SEC));
    this.pairing = new PairingCodeManager(options.pairing);
    this.tickets = new TicketManager(options.tickets);
  }

  /**
   * For CLI startup printing ONLY. Never return in /healthz or unauthenticated endpoints.
   */
  getMasterTokenForCli(): string {
    return this.masterToken;
  }

  verifyBearerHeader(authorizationHeader: string | string[] | undefined): boolean {
    if (typeof authorizationHeader !== 'string') return false;
    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
    if (!match || !match[1]) return false;
    return constantTimeEqual(match[1], this.masterToken);
  }

  verifyBearerToken(token: string): boolean {
    if (!token) return false;
    return constantTimeEqual(token, this.masterToken);
  }

  exchangePairingCode(code: unknown): PairingExchangeResult {
    return this.pairing.exchange(code, this.masterToken, this.tokenExpiresInSec);
  }

  issueTicketForAuthorizedRequest(
    authorizationHeader: string | string[] | undefined,
    clientIp?: string,
  ): { ok: true; issued: IssuedTicket } | { ok: false; status: 401; error: string } {
    if (!this.verifyBearerHeader(authorizationHeader)) {
      return { ok: false, status: 401, error: 'Invalid or missing bearer token' };
    }
    return { ok: true, issued: this.tickets.issue({ clientIp }) };
  }

  /**
   * Authenticates a WebSocket upgrade solely via `Sec-WebSocket-Protocol`:
   * - `ticket.<TICKET>` (preferred, 60s single-use, atomically consumed)
   * - `bearer.<TOKEN>` (constant-time master token check)
   *
   * Rejects missing/invalid/replayed credentials so unauthenticated upgrades get HTTP 401.
   */
  authenticateUpgrade(secWebSocketProtocolHeader: string | string[] | undefined): UpgradeAuthResult {
    const raw = Array.isArray(secWebSocketProtocolHeader)
      ? secWebSocketProtocolHeader.join(',')
      : (secWebSocketProtocolHeader ?? '');
    if (!raw.trim()) {
      return { ok: false, reason: 'missing_credentials' };
    }

    const tokens = raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    for (const proto of tokens) {
      if (proto.startsWith('ticket.')) {
        const ticketValue = proto.slice('ticket.'.length);
        const consumed = this.tickets.consume(ticketValue);
        if (consumed.ok) {
          return { ok: true, method: 'ticket', subprotocol: proto };
        }
        return { ok: false, reason: consumed.reason };
      }
    }

    for (const proto of tokens) {
      if (proto.startsWith('bearer.')) {
        const bearerValue = proto.slice('bearer.'.length);
        if (this.verifyBearerToken(bearerValue)) {
          return { ok: true, method: 'bearer', subprotocol: proto };
        }
        return { ok: false, reason: 'invalid_bearer' };
      }
    }

    return { ok: false, reason: 'unsupported_auth_subprotocol' };
  }
}
