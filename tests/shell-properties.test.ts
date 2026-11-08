import assert from 'node:assert/strict';
import test from 'node:test';
import type { Json, ObjectNode } from '../src/documents/model.js';
import { checkMeta, sortOf, type SortCriterion } from '../src/documents/meta.js';
import { applyPatch } from '../src/documents/ops.js';
import { DEFAULT_RDP, checkStored, fromProps, toProps, type RdpSettings } from '../src/desktop/connection-settings.js';
import { changedMetaProps, metaOf, metaProps, patchFor, rdpOf, subfolderCount, type Meta } from '../src/desktop/properties.js';
import { modelOf } from '../src/desktop/docmodel.js';
import type { Snapshot } from '../src/documents/library.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (type: ObjectNode['type'], props: Record<string, Json>): ObjectNode => ({ id: id(1), type, name: 'x', parentId: null, order: 0, props });
const none: Meta = { notes: '', sort: [] };
const NAME_DOWN: SortCriterion = { by: 'name', dir: 'desc' };
const settings = (over: Partial<RdpSettings> = {}): RdpSettings => ({ ...DEFAULT_RDP, host: 'win.example', username: 'ops', ...over });
const start = (props: Record<string, Json>) => { const n = node('connection', props); return { node: n, rdp: fromProps(props), meta: metaOf(n) }; };

test('what the dialog starts from is read from the object, tolerantly: values that are not valid are nothing, and only a folder has a sort', () => {
  assert.deepEqual(metaOf(node('connection', { notes: 'n', color: 'red', icon: 'server', sort: [NAME_DOWN] })), { notes: 'n', color: 'red', icon: 'server', sort: [] });
  assert.deepEqual(metaOf(node('folder', { notes: 'n', color: 'red', icon: 'box', sort: [NAME_DOWN] })), { notes: 'n', color: 'red', icon: 'box', sort: [NAME_DOWN] });
  assert.deepEqual(metaOf(node('folder', { notes: 5, color: 'plaid', icon: 'nope', sort: 'x' })), { notes: '', sort: [] });
  assert.deepEqual(metaOf(node('folder', {})), none);
});

test('a dialog that changed nothing makes no patch, and a new name is not a change of properties', () => {
  const s = start({ ...toProps(settings()), note: 'keep me' });
  assert.equal(patchFor(s.node, { rdp: s.rdp, meta: s.meta }, { rdp: { ...s.rdp }, meta: { ...s.meta } }), undefined);
  const f = node('folder', {});
  assert.equal(patchFor(f, { meta: none }, { meta: { ...none } }), undefined);
});

test('only the settings the dialog changed are in the patch, and a pin that was cleared is removed', () => {
  const s = start(toProps(settings({ certificateSha256: 'a'.repeat(64), clipboardToRemote: true })));
  const patch = (rdp: RdpSettings) => patchFor(s.node, { rdp: s.rdp, meta: s.meta }, { rdp, meta: s.meta });
  assert.deepEqual(patch({ ...s.rdp, host: 'other.example' }), { set: { host: 'other.example' } });
  assert.deepEqual(patch({ ...s.rdp, port: 3390, username: 'me' }), { set: { port: 3390, username: 'me' } });
  assert.deepEqual(patch({ ...s.rdp, clipboardToRemote: false, clipboardFromRemote: true }), { set: { clipboardToRemote: false, clipboardFromRemote: true } });
  assert.deepEqual(patch({ ...s.rdp, certificateSha256: '' }), { unset: ['certificateSha256'] });
  assert.deepEqual(patch({ ...s.rdp, certificateSha256: 'B'.repeat(64) }), { set: { certificateSha256: 'b'.repeat(64) } }, 'stored in lower case');
  assert.equal(patch({ ...s.rdp, certificateSha256: 'A'.repeat(64) }), undefined, 'a pin typed in another case is the same pin');
});

test('a connection that is not marked as RDP is marked by OK: the dialog shows it as one, and without the mark it cannot be opened', () => {
  const half = start({ host: 'win.example' });
  assert.deepEqual(patchFor(half.node, { rdp: half.rdp, meta: half.meta }, { rdp: { ...half.rdp, username: 'ops' }, meta: half.meta }), { set: { username: 'ops', protocol: 'rdp' } });
  assert.deepEqual(patchFor(half.node, { rdp: half.rdp, meta: half.meta }, { rdp: half.rdp, meta: { ...half.meta, color: 'red' } }), { set: { protocol: 'rdp', color: 'red' } }, 'a colour alone marks it too');
  const whole = start({ host: 'win.example', port: 3389, username: 'ops' });        // valid settings, no mark
  assert.notDeepEqual(checkStored(whole.node.props), [], 'it cannot be opened as it is');
  const unchanged = patchFor(whole.node, { rdp: whole.rdp, meta: whole.meta }, { rdp: whole.rdp, meta: whole.meta });
  assert.deepEqual(unchanged, { set: { protocol: 'rdp' } }, 'OK with nothing changed marks it');
  assert.deepEqual(checkStored(applyPatch(whole.node.props, unchanged!)), [], 'and it can be opened afterwards');
  const pinned = start({ host: 'win.example', port: 3389, username: 'ops', certificateSha256: 'a'.repeat(64) });
  assert.deepEqual(patchFor(pinned.node, { rdp: pinned.rdp, meta: pinned.meta }, { rdp: { ...pinned.rdp, certificateSha256: '' }, meta: pinned.meta }), { set: { protocol: 'rdp' }, unset: ['certificateSha256'] }, 'clearing a pin is a change too');
  const marked = start(toProps(settings()));
  assert.equal(patchFor(marked.node, { rdp: marked.rdp, meta: marked.meta }, { rdp: marked.rdp, meta: marked.meta }), undefined, 'a connection that is marked is left alone when nothing changed');
});

test('notes, colour, icon and sort are set when given and removed when emptied, each on its own', () => {
  const folder = node('folder', { notes: 'old', color: 'red', icon: 'box', sort: [NAME_DOWN], other: 1 });
  const before = { meta: metaOf(folder) };
  const patch = (meta: Meta) => patchFor(folder, before, { meta });
  assert.deepEqual(patch({ ...before.meta, notes: 'new\ntext' }), { set: { notes: 'new\ntext' } });
  assert.deepEqual(patch({ ...before.meta, notes: '' }), { unset: ['notes'] });
  assert.deepEqual(patch({ ...before.meta, color: 'blue' }), { set: { color: 'blue' } });
  assert.deepEqual(patch({ notes: 'old', icon: 'box', sort: [NAME_DOWN] }), { unset: ['color'] }, 'no colour any more');
  assert.deepEqual(patch({ ...before.meta, icon: 'server' }), { set: { icon: 'server' } });
  assert.deepEqual(patch({ ...before.meta, sort: [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }] }), { set: { sort: [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }] } });
  assert.deepEqual(patch({ ...before.meta, sort: [] }), { unset: ['sort'] }, 'manual order again');
  assert.deepEqual(patch({ notes: '', sort: [] }), { unset: ['notes', 'color', 'icon', 'sort'] });
});

/** A seeded generator (mulberry32) that gives a whole number below `n`. A congruential generator computed in float64 loses its low bits and soon gives the same number every time. */
function prng(seed: number): (n: number) => number {
  let a = seed;
  return (n) => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
}

test('the patch gives the object the properties the dialog ended with, changes nothing else, and says only what is valid (random dialogs)', () => {
  const random = prng(9);
  const seen = { folders: 0, connections: 0, colors: new Set<string>(), icons: new Set<string>(), sorts: new Set<string>(), noted: 0, patches: 0, none: 0 };
  const colors = [undefined, 'red', 'teal', 'gray'] as const, icons = [undefined, 'server', 'box'] as const;
  const sorts: SortCriterion[][] = [[], [NAME_DOWN], [{ by: 'type', dir: 'asc' }], [{ by: 'type', dir: 'desc' }, { by: 'name', dir: 'asc' }]];
  const pick = <T>(list: readonly T[]) => list[random(list.length)]!;
  for (let round = 0; round < 200; round++) {
    const type = random(2) ? 'folder' : 'connection';
    const props: Record<string, Json> = { unrelated: { a: [1, 2] }, other: 'o' };
    if (type === 'connection') Object.assign(props, toProps(settings({ port: 3389 + random(3), clipboardToRemote: random(2) === 0 })));
    const color = pick(colors), icon = pick(icons), sort = type === 'folder' ? pick(sorts) : [];
    if (color) props.color = color;
    if (icon) props.icon = icon;
    if (random(2)) props.notes = 'before';
    if (sort.length) props.sort = sort as unknown as Json;
    const n = node(type, props);
    const before = { ...(type === 'connection' ? { rdp: fromProps(props) } : {}), meta: metaOf(n) };
    const ac = pick(colors), ai = pick(icons);
    const afterMeta: Meta = { notes: random(2) ? 'after' : '', ...(ac ? { color: ac } : {}), ...(ai ? { icon: ai } : {}), sort: type === 'folder' ? pick(sorts) : [] };
    const afterRdp = type === 'connection' ? settings({ port: 3389 + random(3), host: random(2) ? 'win.example' : 'h2.example', certificateSha256: random(2) ? '' : 'c'.repeat(64) }) : undefined;
    const after = { ...(afterRdp ? { rdp: afterRdp } : {}), meta: afterMeta };
    const patch = patchFor(n, before, after);
    seen[type === 'folder' ? 'folders' : 'connections']++; seen.colors.add(String(afterMeta.color)); seen.icons.add(String(afterMeta.icon)); seen.sorts.add(JSON.stringify(afterMeta.sort)); if (afterMeta.notes) seen.noted++;
    seen[patch ? 'patches' : 'none']++;
    const next = patch ? applyPatch(props, patch) : props;
    assert.equal(next.unrelated, props.unrelated, `round ${round}: other properties are left alone`);
    assert.equal(next.other, 'o');
    assert.deepEqual(metaOf(node(type, next)), { notes: afterMeta.notes, ...(afterMeta.color ? { color: afterMeta.color } : {}), ...(afterMeta.icon ? { icon: afterMeta.icon } : {}), sort: afterMeta.sort }, `round ${round}: the meta the dialog ended with`);
    if (afterRdp) assert.deepEqual(fromProps(next), afterRdp, `round ${round}: the settings the dialog ended with`);
    if (patch?.set) assert.deepEqual(checkMeta(type, patch.set), [], `round ${round}: what is set is valid`);
    if (patch?.set && patch.unset) assert.equal(patch.unset.some((key) => key in patch.set!), false, `round ${round}: no property both set and removed`);
    assert.deepEqual(sortOf(next), type === 'folder' ? afterMeta.sort : []);
  }
  assert.ok(seen.folders > 50 && seen.connections > 50 && seen.colors.size === colors.length && seen.icons.size === icons.length && seen.sorts.size === sorts.length && seen.noted > 50 && seen.patches > 100, `the dialogs vary in every way: ${JSON.stringify({ ...seen, colors: [...seen.colors], icons: [...seen.icons], sorts: seen.sorts.size })}`);
});

test('notes are read the way the dialog\'s text box gives them back: line breaks are one kind, so a dialog that changed nothing makes no patch', () => {
  const n = node('connection', { ...toProps(settings()), notes: 'a\r\nb\rc\nd' });
  assert.equal(metaOf(n).notes, 'a\nb\nc\nd');
  const s = { node: n, rdp: fromProps(n.props), meta: metaOf(n) };
  assert.equal(patchFor(n, { rdp: s.rdp, meta: s.meta }, { rdp: { ...s.rdp }, meta: { ...s.meta, notes: s.meta.notes } }), undefined);
});

test('a new object starts with the meta the dialog gave it, and only that: nothing empty is stored, and what is stored is valid', () => {
  assert.deepEqual(metaProps({ notes: '', sort: [] }), {});
  assert.deepEqual(metaProps({ notes: 'n', color: 'red', icon: 'box', sort: [NAME_DOWN] }), { notes: 'n', color: 'red', icon: 'box', sort: [NAME_DOWN] });
  assert.deepEqual(checkMeta('folder', metaProps({ notes: 'n', color: 'teal', icon: 'key', sort: [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }] })), []);
  const stored = metaProps({ notes: '', sort: [NAME_DOWN] });
  assert.notEqual(stored.sort, undefined);
  (stored.sort as unknown as SortCriterion[])[0]!.dir = 'asc';
  assert.equal(NAME_DOWN.dir, 'desc', 'what is stored is a copy, not the dialog\'s own objects');
});

const folderTree = (): Snapshot => {
  const f = (n: number, parentId: string | null, type: ObjectNode['type'] = 'folder'): ObjectNode => ({ id: id(n), type, name: `n${n}`, parentId, order: n, props: {} });
  return { id: id(900), docId: id(901), name: 'd', revision: 1, dirty: false, conflicts: 0, seq: 1, objects: [f(1, null), f(2, id(1)), f(3, id(2)), f(4, id(2), 'connection'), f(5, id(1), 'connection'), f(6, null)] } as Snapshot;
};
test('the number of folders below a folder is counted at any depth, not counting the folder itself or connections', () => {
  const model = modelOf(folderTree());
  assert.equal(subfolderCount(model, id(1)), 2);
  assert.equal(subfolderCount(model, id(2)), 1);
  assert.equal(subfolderCount(model, id(3)), 0);
  assert.equal(subfolderCount(model, id(6)), 0);
  assert.equal(subfolderCount(model, id(77)), 0, 'an object that is not there has none');
});

test('a sort that changed only in direction, or only in the property, is a change; the same sort again is not', () => {
  const folder = node('folder', { sort: [NAME_DOWN] });
  const before = { meta: metaOf(folder) };
  assert.deepEqual(patchFor(folder, before, { meta: { ...before.meta, sort: [{ by: 'name', dir: 'asc' }] } }), { set: { sort: [{ by: 'name', dir: 'asc' }] } });
  assert.deepEqual(patchFor(folder, before, { meta: { ...before.meta, sort: [{ by: 'type', dir: 'desc' }] } }), { set: { sort: [{ by: 'type', dir: 'desc' }] } });
  assert.equal(patchFor(folder, before, { meta: { ...before.meta, sort: [{ by: 'name', dir: 'desc' }] } }), undefined);
});

test('a connection with a setting of the wrong type is repaired by the dialog: what the dialog shows for it is written, whether or not anything else was changed', () => {
  const props = { ...toProps(settings()), port: '3390', clipboardToRemote: 'yes', clipboardFromRemote: 5, certificateSha256: 7 };
  const n = node('connection', props);
  const before = { rdp: fromProps(props), meta: metaOf(n) };
  const untouched = patchFor(n, before, { rdp: { ...before.rdp }, meta: before.meta });
  assert.deepEqual(untouched, { set: { port: 3389, clipboardToRemote: false, clipboardFromRemote: false }, unset: ['certificateSha256'] }, 'OK on a dialog that changed nothing repairs what was wrong');
  assert.deepEqual(checkStored(applyPatch(props, untouched!)), []);
  const withHost = patchFor(n, before, { rdp: { ...before.rdp, host: 'other.example', certificateSha256: 'A'.repeat(64) }, meta: before.meta })!;
  assert.deepEqual(withHost.set, { host: 'other.example', port: 3389, clipboardToRemote: false, clipboardFromRemote: false, certificateSha256: 'a'.repeat(64) });
  assert.equal(withHost.unset, undefined);
  assert.deepEqual(checkStored(applyPatch(props, withHost)), [], 'whatever else the dialog changes, the result is a connection that can be opened');
  const fine = node('connection', toProps(settings()));
  assert.equal(patchFor(fine, { rdp: fromProps(fine.props), meta: metaOf(fine) }, { rdp: fromProps(fine.props), meta: metaOf(fine) }), undefined, 'a connection that is fine is left alone');
  const empty = node('connection', { ...toProps(settings()), host: 7, username: false });   // a host or a user of the wrong type shows as empty, and the dialog does not accept an empty one
  const typed = patchFor(empty, { rdp: fromProps(empty.props), meta: metaOf(empty) }, { rdp: { ...fromProps(empty.props), host: 'fixed.example', username: 'ops' }, meta: metaOf(empty) })!;
  assert.deepEqual(checkStored(applyPatch(empty.props, typed)), [], 'what the person had to type is written');
});

test('the settings of a connection are the dialog\'s only when it is RDP or not marked yet: a connection of another protocol keeps them', () => {
  assert.deepEqual(rdpOf(node('connection', toProps(settings()))), settings());
  assert.deepEqual(rdpOf(node('connection', { host: 'win.example' }))?.host, 'win.example');
  assert.equal(rdpOf(node('connection', { protocol: 'ssh', host: 'ssh.example', port: 22 })), undefined);
  assert.notEqual(rdpOf(node('connection', { protocol: 5, host: 'x' })), undefined, 'a protocol that is not even text marks nothing');
  assert.equal(rdpOf(node('folder', {})), undefined);
});

test('asking for the sort to be spread puts the sort the dialog shows in the patch, changed or not, so that the folders below get what the person saw', () => {
  const folder = node('folder', { sort: [NAME_DOWN], keep: 1 });
  const before = { meta: metaOf(folder) };
  assert.deepEqual(patchFor(folder, before, { meta: { ...before.meta } }), undefined, 'not asked: nothing');
  assert.deepEqual(patchFor(folder, before, { meta: { ...before.meta } }, { spread: true }), { set: { sort: [NAME_DOWN] } });
  const manual = node('folder', {});
  assert.deepEqual(patchFor(manual, { meta: metaOf(manual) }, { meta: metaOf(manual) }, { spread: true }), { unset: ['sort'] }, 'manual is spread as manual');
  const odd = node('folder', { sort: [{ by: 'date', dir: 'desc' }] });        // a newer version stored what this one does not know: it shows as manual
  assert.deepEqual(patchFor(odd, { meta: metaOf(odd) }, { meta: metaOf(odd) }, { spread: true }), { unset: ['sort'] }, 'and is replaced by what is shown, not copied');
});

test('what the dialog may be held to is what it changed: a stored value it did not change was not written by it', () => {
  const stored: Meta = { notes: 'x'.repeat(5000), color: 'red', sort: [] };
  assert.deepEqual(changedMetaProps(stored, { ...stored }), {});
  assert.deepEqual(changedMetaProps(stored, { ...stored, color: 'blue' }), { color: 'blue' });
  assert.deepEqual(changedMetaProps(stored, { notes: '', sort: [] }), {}, 'what is taken away is not written');
  assert.deepEqual(changedMetaProps({ notes: '', sort: [] }, { notes: 'n', color: 'teal', icon: 'box', sort: [NAME_DOWN] }), { notes: 'n', color: 'teal', icon: 'box', sort: [NAME_DOWN] }, 'a new object: everything it gives');
  assert.deepEqual(changedMetaProps({ notes: 'a', sort: [NAME_DOWN] }, { notes: 'a', sort: [{ by: 'name', dir: 'asc' }] }), { sort: [{ by: 'name', dir: 'asc' }] });
});
