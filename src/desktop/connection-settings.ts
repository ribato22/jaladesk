// A stored RDP connection and the request the RDP engine takes. The stored form is flat (one property per setting) so that the three-way
// merge of two editors compares setting by setting. validateTarget() stays the single place that decides what a host, port, user and pin
// may be; this module only asks it, field by field, so the properties dialog can name every field that is wrong.
import type { Json, ObjectNode } from '../documents/model.js';
import { validateTarget } from '../protocols/rdp/wire.js';

export type RdpSettings = { host: string; port: number; username: string; certificateSha256: string; clipboardToRemote: boolean; clipboardFromRemote: boolean };
export type Problem = { field: keyof RdpSettings | 'protocol'; message: string };
export type RdpRequest = { host: string; port: number; username: string; certificateSha256: string; clipboard: { toRemote: boolean; fromRemote: boolean } };

export const DEFAULT_RDP: RdpSettings = { host: '', port: 3389, username: '', certificateSha256: '', clipboardToRemote: false, clipboardFromRemote: false };

const texts: Record<'host' | 'port' | 'username' | 'certificateSha256', string> = {
  host: 'Host kosong, lebih dari 253 karakter, atau memuat spasi atau karakter kontrol.',
  port: 'Port harus bilangan bulat 1 sampai 65535.',
  username: 'Pengguna kosong, lebih dari 256 karakter, atau memuat karakter kontrol.',
  certificateSha256: 'SHA-256 sertifikat harus 64 karakter hexadecimal, atau dikosongkan.',
};

// Everything else is held at a value validateTarget accepts, so that exactly one field decides each answer.
const accepts = (patch: Record<string, unknown>): boolean => {
  try { validateTarget({ host: 'h', port: 3389, username: 'u', ...patch }); return true; } catch { return false; }
};

export function checkSettings(s: RdpSettings): Problem[] {
  const problems: Problem[] = [];
  if (!accepts({ host: s.host })) problems.push({ field: 'host', message: texts.host });
  if (!accepts({ port: s.port })) problems.push({ field: 'port', message: texts.port });
  if (!accepts({ username: s.username })) problems.push({ field: 'username', message: texts.username });
  if (!accepts({ certificateSha256: s.certificateSha256 })) problems.push({ field: 'certificateSha256', message: texts.certificateSha256 });
  return problems;
}

export function toProps(s: RdpSettings): Record<string, Json> {
  const props: Record<string, Json> = { protocol: 'rdp', host: s.host, port: s.port, username: s.username };
  if (s.certificateSha256 !== '') props.certificateSha256 = s.certificateSha256.toLowerCase();
  props.clipboardToRemote = s.clipboardToRemote;
  props.clipboardFromRemote = s.clipboardFromRemote;
  return props;
}

const kinds: Record<string, 'string' | 'number' | 'boolean'> = { host: 'string', port: 'number', username: 'string', certificateSha256: 'string', clipboardToRemote: 'boolean', clipboardFromRemote: 'boolean' };

/** What is stored, checked strictly: the protocol, the type of every setting that is present, then the values. A wrong type is a problem, not a default. */
export function checkStored(props: Record<string, Json>): Problem[] {
  const problems: Problem[] = [];
  if (props.protocol !== 'rdp') problems.push({ field: 'protocol', message: 'Hanya koneksi RDP yang didukung.' });
  for (const [key, kind] of Object.entries(kinds)) {
    if (key in props && typeof props[key] !== kind) problems.push({ field: key as keyof RdpSettings, message: `Nilai ${key} bertipe salah.` });
  }
  return problems.length > 0 ? problems : checkSettings(fromProps(props));
}

export const managed = ['protocol', 'host', 'port', 'username', 'certificateSha256', 'clipboardToRemote', 'clipboardFromRemote'];

/** The stored properties after the dialog's settings are applied: every setting the dialog owns is replaced (a cleared pin is removed), everything else is kept. */
export function withSettings(props: Record<string, Json>, s: RdpSettings): Record<string, Json> {
  const kept = Object.fromEntries(Object.entries(props).filter(([key]) => !managed.includes(key)));
  return { ...kept, ...toProps(s) };
}

/** Reads what is stored; a missing value or one of the wrong type takes the default, so a half-filled connection can still be edited. */
export function fromProps(props: Record<string, Json>): RdpSettings {
  const text = (key: string, fallback: string) => (typeof props[key] === 'string' ? (props[key] as string) : fallback);
  const flag = (key: string) => props[key] === true;
  return {
    host: text('host', DEFAULT_RDP.host),
    port: typeof props.port === 'number' ? props.port : DEFAULT_RDP.port,
    username: text('username', DEFAULT_RDP.username),
    certificateSha256: text('certificateSha256', DEFAULT_RDP.certificateSha256).toLowerCase(),
    clipboardToRemote: flag('clipboardToRemote'),
    clipboardFromRemote: flag('clipboardFromRemote'),
  };
}

export type Opening = { ok: true; request: RdpRequest; label: string } | { ok: false; problems: Problem[] };

/** The request for opening a stored connection, or why it cannot be opened. */
export function requestFor(node: ObjectNode): Opening {
  if (node.type !== 'connection') return { ok: false, problems: [{ field: 'protocol', message: 'Hanya koneksi yang dapat dibuka.' }] };
  const problems = checkStored(node.props);
  if (problems.length > 0) return { ok: false, problems };
  const s = fromProps(node.props);
  return { ok: true, label: node.name, request: { host: s.host, port: s.port, username: s.username, certificateSha256: s.certificateSha256, clipboard: { toRemote: s.clipboardToRemote, fromRemote: s.clipboardFromRemote } } };
}
