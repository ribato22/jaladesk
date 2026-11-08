// Main-only registry for one user's fixed overlay file; renderer requests contain object references, never paths or secret records.
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { isGroup, isGroupValue, isPlainRecord, GROUP_REGISTRY, type CredentialSelection, type Group } from '../documents/groups.js';
import type { DocumentLibrary } from '../documents/library.js';
import { UUID, type Json, type SecretRecord } from '../documents/model.js';
import { validateSecret } from '../documents/schema-v2.js';
import { OverrideError, OverrideSession, type OverrideState, type OverrideWarning } from '../documents/overrides.js';
import { realFs, type Options } from '../documents/store.js';
import type { Choice } from '../documents/conflicts.js';
import { renameInto } from './settings.js';

export type OverrideDependencies = {
  path: string; options?: Options; newId?(): string;
  askPassword(purpose: 'create' | 'unlock'): Promise<string | undefined>;
  /** Trusted main receives previous; the isolated window receives safe metadata only. */
  prompt(request: { group: Group; hasValue: boolean; previous?: SecretRecord }): Promise<SecretRecord | false | undefined>;
  confirmDirty(): Promise<'save' | 'discard' | 'cancel'>;
  confirmDisable?(): Promise<boolean>;
};
type Ref = { id: string; expectedSeq?: number; objectId: string };
type Edit = Ref & { expectedSeq: number; overlaySeq: number; group: Group; inherit?: boolean; value?: Json };
const fail = (code: ConstructorParameters<typeof OverrideError>[0]): never => { throw new OverrideError(code); };
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isPlainRecord(value) && Object.keys(value).every(key => keys.includes(key));
const protectedGroup = (group: Group) => GROUP_REGISTRY[group].privacy === 'private' && group !== 'credentials';
const safe = (error: unknown): OverrideError => error instanceof OverrideError ? error : new OverrideError('io');

export class OverrideService {
  #entry?: OverrideSession;
  #enabled = false;
  #seq = 0;
  #generation = 0;
  #busy = false;
  #error?: OverrideError;
  private constructor(readonly library: DocumentLibrary, readonly deps: OverrideDependencies) {}
  static async load(library: DocumentLibrary, deps: OverrideDependencies): Promise<OverrideService> {
    const result = new OverrideService(library, deps);
    try {
      const marker = await (deps.options?.fs ?? realFs).readFile(`${deps.path}.enabled`);
      result.#enabled = true;
      if (marker.toString('utf8') !== 'enabled\n') return result.#blocked(new OverrideError('io'));
      result.#entry = await OverrideSession.load(deps.path, { ...deps.options, expected: true });
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') return result.#blocked(new OverrideError('io'));
    }
    return result;
  }
  #touch(): void { this.#seq++; this.#generation++; }
  #blocked(error: OverrideError): this { this.#enabled = true; this.#error = error; this.#touch(); return this; }
  #overlaySeq(value: unknown): void { if (!Number.isSafeInteger(value) || value !== this.#seq) return fail('stale'); }
  #ready(): OverrideSession { if (this.#error) throw this.#error; if (!this.#entry) return fail(this.#enabled ? 'locked' : 'missing'); this.#entry.privateDocument(); return this.#entry; }
  #ref(raw: unknown, extra: string[] = [], required = true): Ref {
    if (!exact(raw, ['id', 'expectedSeq', 'objectId', ...extra]) || typeof raw.id !== 'string' || !raw.id || typeof raw.objectId !== 'string' || !UUID.test(raw.objectId) || (required || Object.hasOwn(raw, 'expectedSeq')) && (!Number.isSafeInteger(raw.expectedSeq) || (raw.expectedSeq as number) < 0)) return fail('invalid');
    return raw as Ref;
  }
  #target(ref: Ref) {
    let source;
    try { source = this.library.privateDocument(ref.id); } catch { return fail('missing'); }
    if (ref.expectedSeq !== undefined && ref.expectedSeq !== source.seq) return fail('stale');
    const node = Object.hasOwn(source.doc.objects, ref.objectId) ? source.doc.objects[ref.objectId] : undefined;
    if (!node) return fail('missing');
    if (!['folder', 'connection', 'template'].includes(node.type) || source.doc.kind === 'overrides') return fail('invalid');
    if (this.library.privateDocuments().filter(entry => entry.doc.id === source.doc.id).length !== 1) return fail('invalid');
    return { ...source, target: { documentId: source.doc.id, objectId: node.id } };
  }
  #unchanged(ref: Ref, sourceGeneration: number, generation: number): void { if (this.#generation !== generation || this.#target(ref).generation !== sourceGeneration) return fail('stale'); }
  state(): OverrideState & { warnings: OverrideWarning[]; enabled: boolean } {
    const state = this.#error ? { status: 'error' as const, dirty: this.#entry?.state.dirty ?? false, conflicts: this.#entry?.state.conflicts ?? [], error: this.#error.code } : this.#entry?.state ?? { status: 'absent' as const, dirty: false, conflicts: [] };
    let warnings: OverrideWarning[] = [];
    if (state.status === 'ready') { try { warnings = this.#entry!.validateTargets(this.library.privateDocuments().map(entry => entry.doc)); } catch { /* Conflicts remain blocked in the entry. */ } }
    return { ...state, seq: this.#seq, generation: this.#generation, enabled: this.#enabled, warnings };
  }
  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.#busy) return fail('busy'); this.#busy = true;
    try { return await run(); } finally { this.#busy = false; }
  }
  async #enable(): Promise<void> {
    // The marker is durable before a new file: a crash between them leaves an expected missing file, never silent fallback.
    this.#enabled = true;
    const fs = this.deps.options?.fs ?? realFs, marker = `${this.deps.path}.enabled`, tmp = `${marker}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(tmp, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from('enabled\n')); await handle.sync(); } finally { await handle.close(); }
      await renameInto(fs, tmp, marker); await fs.syncDir(dirname(this.deps.path)).catch(() => undefined);
    } catch (error) { await fs.unlink(tmp).catch(() => undefined); this.#blocked(safe(error)); throw safe(error); }
  }
  create(): Promise<boolean> { return this.#exclusive(async () => {
    if (this.#entry?.state.status === 'ready') return fail('busy');
    const password = await this.deps.askPassword('create'); if (password === undefined) return false;
    await this.#enable();
    try { const entry = await OverrideSession.create(this.deps.path, password, this.deps.options); this.#entry?.close(); this.#entry = entry; this.#error = undefined; this.#touch(); return true; }
    catch (error) { this.#blocked(safe(error)); throw safe(error); }
  }); }
  unlock(): Promise<boolean> { return this.#exclusive(async () => {
    if (this.#entry?.state.status === 'ready') return true;
    if (!await this.#dirtyDecision()) return false;
    const password = await this.deps.askPassword('unlock'); if (password === undefined) return false;
    await this.#enable();
    try { const entry = await OverrideSession.load(this.deps.path, { ...this.deps.options, expected: true }); await entry.unlock(password); this.#entry?.close(); this.#entry = entry; this.#error = undefined; this.#touch(); return true; }
    catch (error) { this.#blocked(safe(error)); throw safe(error); }
  }); }
  async #flush(): Promise<void> {
    const entry = this.#entry; if (!entry) return fail('locked');
    try { const result = await entry.save(entry.state.seq); this.#error = undefined; this.#touch(); if (!result.saved) return fail('conflict'); }
    catch (error) { this.#blocked(safe(error)); throw safe(error); }
  }
  save(raw: unknown): Promise<void> { return this.#exclusive(async () => { if (!exact(raw, ['expectedSeq'])) return fail('invalid'); this.#overlaySeq(raw.expectedSeq); await this.#flush(); }); }
  resolve(raw: unknown): void {
    if (this.#busy) return fail('busy');
    if (!exact(raw, ['key', 'choice', 'expectedSeq']) || typeof raw.key !== 'string' || !['mine', 'theirs', 'keep', 'delete', 'accept'].includes(raw.choice as string)) return fail('invalid');
    this.#overlaySeq(raw.expectedSeq); if (!this.#entry || this.#entry.state.status !== 'ready') return fail('locked');
    this.#entry.resolve(raw.key, raw.choice as Choice, this.#entry.state.seq); this.#error = undefined; this.#touch();
  }
  async #dirtyDecision(): Promise<boolean> {
    if (!this.#entry?.state.dirty) return true;
    const generation = this.#generation, decision = await this.deps.confirmDirty();
    if (generation !== this.#generation) return fail('stale');
    if (decision === 'cancel') return false;
    if (decision === 'save') await this.#flush();
    else if (decision !== 'discard') return fail('invalid');
    return true;
  }
  lock(): Promise<boolean> { return this.#exclusive(async () => {
    if (!await this.#dirtyDecision()) return false;
    this.#entry?.close(); this.#entry = this.#enabled ? await OverrideSession.load(this.deps.path, { ...this.deps.options, expected: true }) : undefined; this.#error = undefined; this.#touch(); return true;
  }); }
  disable(): Promise<boolean> { return this.#exclusive(async () => {
    if (!this.deps.confirmDisable || !await this.deps.confirmDisable()) return false;
    if (!await this.#dirtyDecision()) return false;
    try { await (this.deps.options?.fs ?? realFs).unlink(`${this.deps.path}.enabled`); }
    catch (error) { if ((error as { code?: string })?.code !== 'ENOENT') { this.#blocked(safe(error)); throw safe(error); } }
    this.#entry?.close(); this.#entry = undefined; this.#enabled = false; this.#error = undefined; this.#touch(); return true;
  }); }
  closeForWindow(): Promise<boolean> { return this.#busy ? Promise.resolve(false) : this.lock(); }
  #selection(value: Json): void {
    if (!isGroupValue('credentials', value)) return fail('invalid');
    const selection = value as CredentialSelection;
    if (selection.mode === 'inline' || selection.mode === 'parent') return fail('invalid');
    const sources = this.library.privateDocuments();
    const source = (id: string) => { const matches = sources.filter(entry => entry.doc.id === id && ['workspace', 'vault'].includes(entry.doc.kind)); if (matches.length !== 1) return fail('invalid'); return matches[0]!.doc; };
    if (selection.mode === 'id' && source(selection.vaultId).objects[selection.credentialId]?.type !== 'credential') return fail('invalid');
    if (selection.mode === 'name') for (const vaultId of selection.scopeVaultIds) source(vaultId);
  }
  set(raw: unknown): Promise<boolean> { return this.#exclusive(async () => {
    const ref = this.#ref(raw, ['overlaySeq', 'group', 'inherit', 'value']) as Edit;
    this.#overlaySeq(ref.overlaySeq); const state = this.#target(ref), entry = this.#ready();
    if (typeof ref.group !== 'string' || !isGroup(ref.group) || typeof ref.inherit !== 'boolean') return fail('invalid');
    const before = entry.state.seq;
    if (ref.inherit) { if (Object.hasOwn(raw as object, 'value')) return fail('invalid'); entry.clear(state.target, [ref.group], entry.state.seq); if (entry.state.seq !== before) this.#touch(); return true; }
    let value = ref.value, record: SecretRecord | undefined;
    const inline = ref.group === 'credentials' && isPlainRecord(value) && value.mode === 'inline' && Object.keys(value).length === 1;
    if (inline || protectedGroup(ref.group) && value === undefined) {
      const prior = entry.layer(state.target)?.groups[ref.group];
      const previous = isPlainRecord(prior) && typeof prior.secretId === 'string' ? entry.privateDocument().doc.secrets[prior.secretId] : undefined;
      const generation = this.#generation, input = await this.deps.prompt({ group: ref.group, hasValue: previous !== undefined, ...(previous ? { previous: structuredClone(previous) } : {}) });
      this.#unchanged(ref, state.generation, generation); if (input === undefined) return false;
      if (input === false) { if (!protectedGroup(ref.group)) return fail('invalid'); value = false; }
      else { try { record = validateSecret(input); } catch { return fail('invalid'); } if (record.kind !== (inline ? 'credential' : 'protected-value')) return fail('invalid'); }
    } else if (ref.group === 'credentials') { if (value === undefined) return fail('invalid'); this.#selection(value); }
    else if (protectedGroup(ref.group) && value !== false) return fail('invalid');
    if (record) {
      const secretId = this.deps.newId?.() ?? randomUUID();
      if (!UUID.test(secretId) || Object.hasOwn(entry.privateDocument().doc.secrets, secretId)) return fail('invalid');
      value = inline ? { mode: 'inline', secretId } : { secretId };
      entry.set(state.target, { [ref.group]: value }, entry.state.seq, { [secretId]: record });
    } else { if (!isGroupValue(ref.group, value)) return fail('invalid'); entry.set(state.target, { [ref.group]: value }, entry.state.seq); }
    if (entry.state.seq !== before) this.#touch(); return true;
  }); }
  clear(raw: unknown): Promise<void> { return this.#exclusive(async () => {
    const ref = this.#ref(raw, ['overlaySeq', 'group']) as Edit; this.#overlaySeq(ref.overlaySeq);
    if (typeof ref.group !== 'string' || !isGroup(ref.group)) return fail('invalid'); const state = this.#target(ref), entry = this.#ready(), before = entry.state.seq; entry.clear(state.target, [ref.group], before); if (entry.state.seq !== before) this.#touch();
  }); }
  layers(raw: unknown) {
    if (this.#error) throw this.#error;
    const ref = this.#ref(raw, [], false), target = this.#target(ref).target;
    if (!this.#enabled) return { overrideGeneration: this.#generation };
    const layer = this.#ready().layer(target);
    return { ...(layer ? { override: { ...layer, ownerGeneration: this.#generation } } : {}), overrideGeneration: this.#generation };
  }
  privateSources() { if (!this.#enabled || this.state().status !== 'ready' || this.state().conflicts.length) return []; const source = this.#ready().privateDocument(); return [{ ...source, generation: this.#generation }]; }
}
