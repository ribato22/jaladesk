export interface GeneratorOptions { length?: number; lowercase?: boolean; uppercase?: boolean; digits?: boolean; symbols?: boolean; excludeAmbiguous?: boolean }
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

/** Rejection of whole candidates keeps every string satisfying the selected classes equally likely. */
export function generatePassword(options: GeneratorOptions = {}, random: RandomBytes = (bytes) => globalThis.crypto.getRandomValues(bytes)): string {
  const length = options.length ?? 20;
  const config = { lowercase: true, uppercase: true, digits: true, symbols: false, excludeAmbiguous: true, ...options };
  if (!Number.isInteger(length) || length < 12 || length > 128 || ['lowercase', 'uppercase', 'digits', 'symbols', 'excludeAmbiguous'].some((key) => typeof config[key as keyof typeof config] !== 'boolean')) throw new Error('Konfigurasi generator tidak valid');
  const classes = [[config.lowercase, 'abcdefghijklmnopqrstuvwxyz'], [config.uppercase, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'], [config.digits, '0123456789'], [config.symbols, '!@#$%&*+-=?_']].filter(([enabled]) => enabled).map(([, chars]) => config.excludeAmbiguous ? (chars as string).replace(/[0O1Il]/g, '') : chars as string);
  if (!classes.length) throw new Error('Konfigurasi generator tidak valid');
  const alphabet = classes.join(''); const limit = 256 - (256 % alphabet.length);
  const bytes = new Uint8Array(length); let candidate = '';
  try {
    for (let attempt = 0; attempt < 4096; attempt++) {
      if (random(bytes) !== bytes) throw new Error();
      for (const byte of bytes) { if (byte < limit && candidate.length < length) candidate += alphabet[byte % alphabet.length]; }
      if (candidate.length === length) {
        if (classes.every((chars) => [...candidate].some((char) => chars.includes(char)))) return candidate;
        candidate = '';
      }
    }
  } catch { throw new Error('Sumber acak tidak tersedia'); }
  finally { bytes.fill(0); }
  throw new Error('Sumber acak tidak tersedia');
}

export interface HygieneEntry { id: string; status: 'available' | 'empty' | 'locked' | 'missing'; password?: string }
export interface HygieneSummary { id: string; status: HygieneEntry['status']; reuseCount: number; length?: number; estimate?: 'rendah' | 'sedang' | 'tinggi' }
export interface HygieneReport { entries: HygieneSummary[]; reuse: { ids: string[]; count: number }[]; notice: string }

/** Each explicit analysis uses a fresh non-exportable HMAC key; neither key nor digest leaves this call. */
export async function analyzeCredentials(entries: readonly HygieneEntry[], scope: { optIn: boolean; ids: readonly string[] }): Promise<HygieneReport> {
  if (scope.optIn !== true) throw new Error('Persetujuan analisis diperlukan');
  if (!Array.isArray(entries) || entries.length > 10000 || !Array.isArray(scope.ids) || scope.ids.length > 10000 || new Set(scope.ids).size !== scope.ids.length || scope.ids.some((id) => typeof id !== 'string' || !id || id.length > 256)) throw new Error('Cakupan analisis tidak valid');
  const selected = new Map<string, HygieneEntry>();
  for (const entry of entries) { if (!entry || typeof entry.id !== 'string' || selected.has(entry.id)) throw new Error('Cakupan analisis tidak valid'); selected.set(entry.id, entry); }
  if (scope.ids.some((id) => !selected.has(id))) throw new Error('Cakupan analisis tidak valid');
  const key = await globalThis.crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const groups = new Map<string, string[]>(); const summaries: HygieneSummary[] = [];
  for (const id of scope.ids) {
    const entry = selected.get(id)!;
    if (!['available', 'empty', 'locked', 'missing'].includes(entry.status)) throw new Error('Cakupan analisis tidak valid');
    const value = entry.status === 'available' ? entry.password : undefined;
    if (entry.status === 'available' && (typeof value !== 'string' || value.length > 65536)) throw new Error('Cakupan analisis tidak valid');
    if (!value) { summaries.push({ id, status: entry.status === 'available' ? 'empty' : entry.status, reuseCount: 0 }); continue; }
    const bytes = new TextEncoder().encode(value);
    const signed = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, bytes)); bytes.fill(0);
    const digest = Array.from(signed, (byte) => byte.toString(16).padStart(2, '0')).join(''); signed.fill(0);
    const ids = groups.get(digest) ?? []; ids.push(id); groups.set(digest, ids);
    const classCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((regex) => regex.test(value)).length;
    summaries.push({ id, status: 'available', reuseCount: 1, length: value.length, estimate: value.length >= 20 && classCount >= 3 ? 'tinggi' : value.length >= 12 && classCount >= 2 ? 'sedang' : 'rendah' });
  }
  const byId = new Map(summaries.map((entry) => [entry.id, entry]));
  for (const ids of groups.values()) for (const id of ids) byId.get(id)!.reuseCount = ids.length;
  const reuse = [...groups.values()].filter((ids) => ids.length > 1).map((ids) => ({ ids, count: ids.length })); groups.clear();
  return { entries: summaries, reuse, notice: 'Perkiraan lokal; bukan audit ketahanan atau pemeriksaan kebocoran.' };
}
