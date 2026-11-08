import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMAND_IDS, EMPTY_REPORT, type CommandId, type Report } from '../src/desktop/commands.js';
import { Settings, SettingsError } from '../src/desktop/settings.js';
import { registerShellIpc, type ShellIpcDeps } from '../src/desktop/shell-ipc.js';
import type { Shell } from '../src/desktop/shell.js';
import { DEFAULT_LAYOUT } from '../src/desktop/toolbar-model.js';

type Handler = (event: unknown, payload?: unknown) => unknown;
function fixture(options: { allow?: boolean; settings?: Settings; notice?: ShellIpcDeps['notice']; runThrows?: boolean } = {}) {
  const handlers = new Map<string, Handler>(), listeners = new Map<string, Handler>();
  const reports: Report[] = [], runs: CommandId[] = [], reported: unknown[] = [];
  let allow = options.allow ?? true;
  const shell: Pick<Shell, 'report' | 'run'> = { report: (r) => { reports.push(r); return true; }, run: async (id) => { runs.push(id); if (options.runThrows) throw new Error('the dialog cannot be shown'); return id.startsWith('view.'); } };
  const settings = options.settings ?? Settings.memory();
  registerShellIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); }, on: (channel, listener) => { listeners.set(channel, listener); } },
    check: () => { if (!allow) throw new Error('Access denied'); }, shell, settings, ...(options.notice ? { notice: options.notice } : {}), report: (error) => { reported.push(error); },
  });
  return { handlers, listeners, reports, runs, reported, settings, deny: () => { allow = false; }, call: (channel: string, payload?: unknown) => handlers.get(channel)!({}, payload) };
}
const VALID: Report = { ...EMPTY_REPORT, enabled: ['doc.save'], tabs: 1, tab: 0 };

test('the shell answers on four channels and listens on one, and no other', () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()].sort(), ['shell:run', 'shell:set-toolbar', 'shell:settings']);
  assert.deepEqual([...f.listeners.keys()], ['shell:report']);
});

test('every channel is closed to anyone but the window of the application', async () => {
  const f = fixture();
  f.deny();
  for (const channel of ['shell:settings', 'shell:set-toolbar', 'shell:run']) await assert.rejects(Promise.resolve().then(() => f.call(channel, {})), /Access denied/, channel);
  f.listeners.get('shell:report')!({}, VALID);
  assert.deepEqual(f.reports, [], 'what a stranger reports is not heard, and does not throw');
});

test('what the window reports is taken in when it is a report, and only then', () => {
  const f = fixture();
  f.listeners.get('shell:report')!({}, VALID);
  assert.deepEqual(f.reports, [VALID]);
  for (const wrong of [undefined, null, 'doc.save', 7, [], {}, { ...VALID, extra: 1 }, { ...VALID, enabled: ['nothing'] }, { ...VALID, tabs: -1 }, { ...VALID, capture: 'yes' }]) f.listeners.get('shell:report')!({}, wrong);
  assert.equal(f.reports.length, 1, 'nothing else got through');
});

test('the window can ask for the settings, and is told a notice about them once', async () => {
  let pending: 'reset' | undefined = 'reset';
  const f = fixture({ notice: () => { const was = pending; pending = undefined; return was; } });
  const first = await f.call('shell:settings') as Record<string, unknown>;
  assert.deepEqual(first, { ok: true, theme: 'system', toolbar: { visible: true, items: DEFAULT_LAYOUT }, notice: 'reset' });
  const second = await f.call('shell:settings') as Record<string, unknown>;
  assert.deepEqual(second, { ok: true, theme: 'system', toolbar: { visible: true, items: DEFAULT_LAYOUT } }, 'told once');
  const plain = await fixture().call('shell:settings') as Record<string, unknown>;
  assert.ok(!('notice' in plain));
});

test('the window can change the toolbar, and a change that is wrong is refused in words, with the settings as they were', async () => {
  const f = fixture();
  const ok = await f.call('shell:set-toolbar', { visible: false, items: ['doc.new', 'nonsense', 'doc.open'] }) as Record<string, unknown>;
  assert.deepEqual(ok, { ok: true, theme: 'system', toolbar: { visible: false, items: ['doc.new', 'doc.open'] } });
  assert.deepEqual(f.settings.values().toolbar, { visible: false, items: ['doc.new', 'doc.open'] });
  for (const wrong of [undefined, null, 'x', 7, [], { visible: 'no' }, { items: 'all' }, { theme: 'dark' }, { extra: 1 }]) {
    const reply = await f.call('shell:set-toolbar', wrong) as { ok: boolean; code?: string; message?: string };
    assert.equal(reply.ok, false, JSON.stringify(wrong));
    assert.equal(reply.code, 'invalid');
    assert.match(reply.message!, /Perubahan toolbar tidak dikenal/);
  }
  assert.deepEqual(f.settings.values().toolbar, { visible: false, items: ['doc.new', 'doc.open'] });
  assert.deepEqual(f.reported, [], 'a wrong change is the window\'s mistake, not an error to report');
});

test('a change that cannot be kept is told as that, and not as a wrong change', async () => {
  const settings = Settings.memory();
  const f = fixture({ settings });
  (settings as unknown as { setToolbar: unknown }).setToolbar = () => Promise.reject(new SettingsError('io', 'cannot be written'));
  const reply = await f.call('shell:set-toolbar', { visible: false }) as { ok: boolean; code?: string; message?: string };
  assert.deepEqual([reply.ok, reply.code], [false, 'io']);
  assert.match(reply.message!, /tidak dapat disimpan/);
  assert.equal(f.reported.length, 1, 'and is reported');
  assert.ok(f.reported[0] instanceof SettingsError);
  (settings as unknown as { setToolbar: unknown }).setToolbar = () => Promise.reject(new Error('something else'));
  const other = await f.call('shell:set-toolbar', { visible: false }) as { ok: boolean; code?: string };
  assert.deepEqual([other.ok, other.code], [false, 'io'], 'any other failure is told as not kept');
  assert.equal(f.reported.length, 2);
});

test('a command of the main process is run when the window asks for it, and a command that is not one of its own is not', async () => {
  const f = fixture();
  assert.deepEqual(await f.call('shell:run', { id: 'view.fullscreen' }), { ok: true });
  assert.deepEqual(f.runs, ['view.fullscreen']);
  const refused = await f.call('shell:run', { id: 'app.quit' }) as { ok: boolean; code: string };
  assert.deepEqual([refused.ok, refused.code], [false, 'refused'], 'the shell said no');
  for (const wrong of [undefined, null, 'view.fullscreen', 7, [], {}, { id: 'nothing' }, { id: 'constructor' }, { id: 5 }, { id: ['view.fullscreen'] }, { id: 'view.fullscreen', extra: 1 }]) {
    const reply = await f.call('shell:run', wrong) as { ok: boolean; code: string };
    assert.deepEqual([reply.ok, reply.code], [false, 'invalid'], JSON.stringify(wrong));
  }
  assert.deepEqual(f.runs, ['view.fullscreen', 'app.quit'], 'what is not a command never reached the shell');
  assert.ok(COMMAND_IDS.includes('view.fullscreen'));
});

// ---- review of the execution (22 October 2026)
test('a command of the main process that throws is reported, and the window is told that it could not be done, not left with the error of Electron', async () => {
  const f = fixture({ runThrows: true });
  const reply = await f.call('shell:run', { id: 'app.about' }) as Record<string, unknown>;
  assert.deepEqual(reply, { ok: false, code: 'refused', message: 'Perintah tidak dapat dijalankan sekarang.' });
  assert.equal(f.reported.length, 1);
  assert.match(String(f.reported[0]), /the dialog cannot be shown/);
});

test('the sender is checked before the notice is taken: a stranger does not use up what the window is to be told', async () => {
  let asked = 0;
  const f = fixture({ notice: () => { asked++; return 'reset'; } });
  f.deny();
  await assert.rejects(Promise.resolve().then(() => f.call('shell:settings')), /Access denied/);
  assert.equal(asked, 0);
});

