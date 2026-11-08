import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextRequest } from '../src/desktop/context-menu.js';
import type { View } from '../src/desktop/shell.js';
import { registerViewIpc } from '../src/desktop/view-ipc.js';

type Handler = (event: unknown, payload?: unknown) => unknown;
function fixture(options: { allow?: boolean; throws?: boolean } = {}) {
  const handlers = new Map<string, Handler>(), listeners = new Map<string, Handler>();
  const asked: ContextRequest[] = [], reported: unknown[] = [];
  let allow = options.allow ?? true;
  let view: View = { colorTabs: true, extended: false };
  registerViewIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, on: (channel, listener) => { listeners.set(channel, listener); } },
    check: () => { if (!allow) throw new Error('Access denied'); },
    shell: { view: () => view, context: (request) => { asked.push(request); if (options.throws) throw new Error('no menu'); } },
    report: (error) => { reported.push(error); },
  });
  return { handlers, listeners, asked, reported, deny: () => { allow = false; }, show: (next: View) => { view = next; } };
}

test('the window can ask how it should look, and is told what the shell says now', async () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], ['shell:view']);
  assert.deepEqual([...f.listeners.keys()], ['shell:context']);
  assert.deepEqual(await f.handlers.get('shell:view')!({}), { ok: true, colorTabs: true, extended: false });
  f.show({ colorTabs: false, extended: true });
  assert.deepEqual(await f.handlers.get('shell:view')!({}), { ok: true, colorTabs: false, extended: true });
});

test('a stranger is refused on both channels: the question is answered with an error, and a request for a menu is not heard', async () => {
  const f = fixture();
  f.deny();
  await assert.rejects(Promise.resolve().then(() => f.handlers.get('shell:view')!({})), /Access denied/);
  f.listeners.get('shell:context')!({}, { kind: 'tree', x: 1, y: 1 });
  assert.deepEqual(f.asked, []);
});

test('a request for a menu is taken in when it is a kind and a place and nothing else; anything else is not heard and does not throw', () => {
  const f = fixture();
  f.listeners.get('shell:context')!({}, { kind: 'tab', x: 10, y: 20 });
  assert.deepEqual(f.asked, [{ kind: 'tab', x: 10, y: 20 }]);
  for (const wrong of [undefined, null, 'tree', 3, [], {}, { kind: 'edit', x: 1, y: 1 }, { kind: 'tree', x: -1, y: 1 }, { kind: 'tree', x: 1, y: 1, items: ['app.quit'] }, { kind: 'tree', x: '1', y: 1 }]) f.listeners.get('shell:context')!({}, wrong);
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.reported, []);
});

test('a menu that cannot be shown is reported and does not throw into the channel', () => {
  const f = fixture({ throws: true });
  f.listeners.get('shell:context')!({}, { kind: 'toolbar', x: 1, y: 1 });
  assert.equal(f.reported.length, 1);
});
