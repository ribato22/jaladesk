import assert from 'node:assert/strict';
import test from 'node:test';
import type { RevisionView } from '../src/documents/library.js';
import type { ObjectNode } from '../src/documents/model.js';
import { REVISION_SESSION, marksOf, restoreFolderName, revisionModel, summaryOf, timeLabel } from '../src/desktop/history-view.js';
import { buildRows, documentKey, objectKey } from '../src/desktop/navigation.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, over: Partial<ObjectNode> = {}): ObjectNode => ({ id: id(n), type: 'connection', name: `n${n}`, parentId: null, order: n, props: {}, ...over });
const view = (over: Partial<RevisionView> = {}): RevisionView => ({
  name: '20231114T221320123Z-0123456789ab.rwdoc', at: 1_700_000_000_123, docName: 'Lab',
  objects: [node(1, { type: 'folder', name: 'Servers' }), node(2, { parentId: id(1), order: 0 }), node(3, { parentId: id(1), order: 1 })], gone: [id(3)], changed: [id(2)], added: 4, ...over,
});

test('the time of a revision is written for a person, in Indonesian, with the date and the time of day, and the folder that a restore makes is named after it', () => {
  const label = timeLabel(1_700_000_000_123, 'UTC');
  assert.match(label, /2023/);
  assert.match(label, /22[.:]13[.:]20/);
  assert.match(timeLabel(Date.UTC(2023, 7, 14, 22, 13, 20), 'UTC'), /14 Agu 2023/, 'the month is written as in Indonesian, short: not "Aug", not "Agustus"');
  assert.match(timeLabel(Date.UTC(2023, 11, 3, 8, 5, 9), 'UTC'), /3 Des 2023/);
  assert.equal(restoreFolderName(1_700_000_000_123, 'UTC'), `Dipulihkan ${label}`);
  assert.ok(restoreFolderName(0).length <= 256);
  assert.ok(timeLabel(Number.NaN).length > 0, 'a time that cannot be read is still some text');
});

test('a revision becomes a model the tree can draw, with the name it had, under a session of its own that can never be a document', () => {
  const model = revisionModel(view());
  assert.deepEqual([model.id, model.name, model.dirty, model.conflicts, model.objects.size], [REVISION_SESSION, 'Lab', false, 0, 3]);
  const rows = buildRows([model], new Set([documentKey(REVISION_SESSION), objectKey(REVISION_SESSION, id(1))]));
  assert.deepEqual(rows.map((r) => r.name), ['Lab', 'Servers', 'n2', 'n3']);
  assert.equal(REVISION_SESSION.includes(':'), false, 'keys are cut at the colons');
});

test('the objects that the document does not have any more and those that are different are marked by the key of their row; the summary says how many of each, and how many are new', () => {
  const marks = marksOf(view());
  assert.deepEqual([...marks], [[objectKey(REVISION_SESSION, id(3)), 'gone'], [objectKey(REVISION_SESSION, id(2)), 'changed']]);
  assert.equal(summaryOf(view()), '1 objek tidak ada lagi · 1 berbeda · 4 objek baru sejak revisi ini');
  assert.equal(summaryOf(view({ gone: [], changed: [], added: 0 })), 'Sama dengan dokumen sekarang.');
  assert.equal(summaryOf(view({ gone: [id(2), id(3)], changed: [], added: 0 })), '2 objek tidak ada lagi');
  assert.equal(summaryOf(view({ gone: [], changed: [id(2)], added: 1 })), '1 berbeda · 1 objek baru sejak revisi ini');
});
