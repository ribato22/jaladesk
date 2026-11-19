/**
 * JalaDesk Self-Hosted Web Gateway — Target SSRF & CIDR Policy Engine
 *
 * Enforces strict destination validation before the Gateway opens any RDP, VNC,
 * SSH, or SFTP socket:
 * - Unconditionally blocks cloud metadata endpoints (IPv4, IPv4-mapped IPv6,
 *   IPv6 AWS IMDS, GCP/Azure/Alibaba metadata hostnames & IPs).
 * - Rejects invalid ports, control characters, and obfuscated numeric IPs.
 * - Supports optional operator-configured `allowCidrs` & `denyCidrs` (IPv4 & IPv6)
 *   plus DNS resolution checks to prevent DNS-rebinding SSRF.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  mask: bigint;
  prefixLen: number;
  raw: string;
}

export interface TargetPolicyOptions {
  allowCidrs?: readonly string[];
  denyCidrs?: readonly string[];
  allowLoopback?: boolean;
  dnsLookup?: (hostname: string) => Promise<string[]>;
}

export type TargetCheckResult =
  | { ok: true; host: string; port: number; resolvedIps: string[] }
  | { ok: false; code: 'invalid_host' | 'invalid_port' | 'metadata_blocked' | 'cidr_denied' | 'cidr_not_allowed' | 'loopback_blocked'; reason: string };

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
  'metadata.packet.net',
]);

const HARD_DENY_METADATA_CIDRS: readonly string[] = [
  '169.254.169.254/32', // AWS / GCP / Azure / DigitalOcean IMDS
  '169.254.170.2/32', // AWS ECS task metadata
  '169.254.169.253/32', // AWS Time Sync / DNS metadata
  '100.100.100.200/32', // Alibaba Cloud metadata
  'fd00:ec2::254/128', // AWS IPv6 IMDS
];

const LOOPBACK_CIDRS: readonly string[] = ['127.0.0.0/8', '::1/128'];

export function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null; // Reject octal ambiguity
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

export function ipv6ToBigInt(rawIp: string): bigint | null {
  // Strip optional zone id (e.g. fe80::1%eth0)
  const ip = rawIp.split('%')[0]!.toLowerCase();
  if (isIP(ip) !== 6) return null;

  // Handle embedded IPv4 tail (e.g. ::ffff:169.254.169.254)
  let work = ip;
  const lastColon = work.lastIndexOf(':');
  if (lastColon >= 0 && work.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToBigInt(work.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = Number((v4 >> 16n) & 0xffffn).toString(16);
    const lo = Number(v4 & 0xffffn).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = work.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }

  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * Extracts embedded IPv4 from IPv4-mapped IPv6 (`::ffff:a.b.c.d`) or IPv4-compatible IPv6
 * so IPv4 metadata & CIDR rules cannot be bypassed via `::ffff:169.254.169.254`.
 */
function extractMappedIpv4(v6: bigint): bigint | null {
  const prefix = v6 >> 32n;
  if (prefix === 0xffffn) {
    return v6 & 0xffffffffn;
  }
  return null;
}

export function parseCidr(raw: string): ParsedCidr {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  const ipPart = (slash >= 0 ? trimmed.slice(0, slash) : trimmed).replace(/^\[|\]$/g, '');
  const family = isIP(ipPart);
  if (family !== 4 && family !== 6) {
    throw new Error(`Invalid CIDR IP address: ${raw}`);
  }
  const bits = family === 4 ? 32 : 128;
  const prefixLen = slash >= 0 ? Number(trimmed.slice(slash + 1)) : bits;
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > bits) {
    throw new Error(`Invalid CIDR prefix length: ${raw}`);
  }

  const addr = family === 4 ? ipv4ToBigInt(ipPart) : ipv6ToBigInt(ipPart);
  if (addr === null) {
    throw new Error(`Unable to parse CIDR address: ${raw}`);
  }

  const totalBits = BigInt(bits);
  const allOnes = (1n << totalBits) - 1n;
  const mask = prefixLen === 0 ? 0n : (allOnes << (totalBits - BigInt(prefixLen))) & allOnes;
  return {
    family,
    network: addr & mask,
    mask,
    prefixLen,
    raw: trimmed,
  };
}

export function ipMatchesCidr(ip: string, cidr: ParsedCidr): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(clean);
  if (family === 4) {
    const v4 = ipv4ToBigInt(clean);
    if (v4 === null) return false;
    if (cidr.family === 4) {
      return (v4 & cidr.mask) === cidr.network;
    }
    return false;
  }
  if (family === 6) {
    const v6 = ipv6ToBigInt(clean);
    if (v6 === null) return false;
    if (cidr.family === 6) {
      return (v6 & cidr.mask) === cidr.network;
    }
    // Check IPv4-mapped IPv6 against IPv4 CIDR rules
    const mappedV4 = extractMappedIpv4(v6);
    if (mappedV4 !== null && cidr.family === 4) {
      return (mappedV4 & cidr.mask) === cidr.network;
    }
  }
  return false;
}

/**
 * Rejects integer/hex/octal obfuscated IPv4 notations (e.g. `2852039166`, `0xa9fea9fe`, `0251.0376.0251.0376`).
 */
function looksLikeObfuscatedIp(host: string): boolean {
  if (/^\d+$/.test(host)) return true;
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  const parts = host.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
    // Standard dotted decimal IPv4 is handled by isIP(host) === 4; anything else numeric is obfuscated
    return isIP(host) !== 4;
  }
  return false;
}

async function defaultDnsLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export class TargetPolicy {
  private readonly hardDenyMetadata: ParsedCidr[];
  private readonly loopbackCidrs: ParsedCidr[];
  private readonly allowCidrs: ParsedCidr[];
  private readonly denyCidrs: ParsedCidr[];
  private readonly allowLoopback: boolean;
  private readonly dnsLookup: (hostname: string) => Promise<string[]>;

  constructor(options: TargetPolicyOptions = {}) {
    this.hardDenyMetadata = HARD_DENY_METADATA_CIDRS.map(parseCidr);
    this.loopbackCidrs = LOOPBACK_CIDRS.map(parseCidr);
    this.allowCidrs = (options.allowCidrs ?? []).filter(Boolean).map(parseCidr);
    this.denyCidrs = (options.denyCidrs ?? []).filter(Boolean).map(parseCidr);
    this.allowLoopback = options.allowLoopback ?? true;
    this.dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  }

  private checkIp(ip: string): TargetCheckResult | null {
    for (const meta of this.hardDenyMetadata) {
      if (ipMatchesCidr(ip, meta)) {
        return {
          ok: false,
          code: 'metadata_blocked',
          reason: `Target IP ${ip} is blocked (cloud metadata endpoint)`,
        };
      }
    }
    if (!this.allowLoopback) {
      for (const lo of this.loopbackCidrs) {
        if (ipMatchesCidr(ip, lo)) {
          return {
            ok: false,
            code: 'loopback_blocked',
            reason: `Loopback target ${ip} is disabled by gateway policy`,
          };
        }
      }
    }
    for (const denied of this.denyCidrs) {
      if (ipMatchesCidr(ip, denied)) {
        return {
          ok: false,
          code: 'cidr_denied',
          reason: `Target IP ${ip} matched denied CIDR ${denied.raw}`,
        };
      }
    }
    if (this.allowCidrs.length > 0) {
      const allowed = this.allowCidrs.some((cidr) => ipMatchesCidr(ip, cidr));
      if (!allowed) {
        return {
          ok: false,
          code: 'cidr_not_allowed',
          reason: `Target IP ${ip} is outside gateway allowCidrs`,
        };
      }
    }
    return null;
  }

  validateSync(rawHost: string, rawPort: number): TargetCheckResult {
    if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
      return { ok: false, code: 'invalid_port', reason: `Invalid target port: ${rawPort}` };
    }
    if (typeof rawHost !== 'string') {
      return { ok: false, code: 'invalid_host', reason: 'Target host is required' };
    }
    const trimmed = rawHost.trim().replace(/^\[|\]$/g, '');
    if (!trimmed || trimmed.length > 253 || /[\s\x00-\x1f/\\@]/.test(trimmed)) {
      return { ok: false, code: 'invalid_host', reason: 'Invalid target host syntax' };
    }

    const lowered = trimmed.toLowerCase().replace(/\.+$/, '');
    if (BLOCKED_METADATA_HOSTS.has(lowered) || lowered.endsWith('.metadata.google.internal')) {
      return {
        ok: false,
        code: 'metadata_blocked',
        reason: `Target host ${trimmed} is blocked (cloud metadata endpoint)`,
      };
    }

    if (looksLikeObfuscatedIp(lowered)) {
      return {
        ok: false,
        code: 'invalid_host',
        reason: `Obfuscated numeric host literal ${trimmed} is rejected`,
      };
    }

    const ipFamily = isIP(trimmed);
    if (ipFamily === 4 || ipFamily === 6) {
      const failure = this.checkIp(trimmed);
      if (failure) return failure;
      return { ok: true, host: trimmed, port: rawPort, resolvedIps: [trimmed] };
    }

    if (!this.allowLoopback && (lowered === 'localhost' || lowered.endsWith('.localhost'))) {
      return {
        ok: false,
        code: 'loopback_blocked',
        reason: `Loopback host ${trimmed} is disabled by gateway policy`,
      };
    }

    // Strict DNS hostname characters
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(lowered)) {
      return { ok: false, code: 'invalid_host', reason: `Invalid hostname: ${trimmed}` };
    }

    return { ok: true, host: lowered, port: rawPort, resolvedIps: [] };
  }

  async validate(rawHost: string, rawPort: number): Promise<TargetCheckResult> {
    const syncResult = this.validateSync(rawHost, rawPort);
    if (!syncResult.ok) return syncResult;
    if (syncResult.resolvedIps.length > 0) return syncResult;

    let ips: string[];
    try {
      ips = await this.dnsLookup(syncResult.host);
    } catch {
      // If allowCidrs is configured, fail closed when DNS cannot be resolved
      if (this.allowCidrs.length > 0) {
        return {
          ok: false,
          code: 'cidr_not_allowed',
          reason: `Could not resolve hostname ${syncResult.host} to verify allowCidrs`,
        };
      }
      return syncResult;
    }

    if (ips.length === 0 && this.allowCidrs.length > 0) {
      return {
        ok: false,
        code: 'cidr_not_allowed',
        reason: `Hostname ${syncResult.host} resolved to zero addresses`,
      };
    }

    for (const ip of ips) {
      const failure = this.checkIp(ip);
      if (failure) return failure;
    }

    return { ok: true, host: syncResult.host, port: rawPort, resolvedIps: ips };
  }
}
