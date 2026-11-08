import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS, keysFor, type Platform } from '../src/desktop/commands.js';
import { RESERVED_IN_CAPTURE } from '../src/desktop/menu-model.js';
import { matchesAccelerator, reservedCommand, type KeyInput } from '../src/desktop/key-match.js';

const press = (key: string, code: string, modifiers: Partial<Pick<KeyInput, 'meta' | 'control' | 'alt' | 'shift'>> = {}, more: Partial<KeyInput> = {}): KeyInput =>
  ({ type: 'keyDown', key, code, isAutoRepeat: false, meta: false, control: false, alt: false, shift: false, ...modifiers, ...more });

test('a key press is the key that an accelerator names only when the modifiers are exactly those and the key is that one', () => {
  assert.equal(matchesAccelerator('Cmd+Q', press('q', 'KeyQ', { meta: true })), true);
  assert.equal(matchesAccelerator('Cmd+Q', press('Q', 'KeyQ', { meta: true })), true, 'the capital that Caps Lock gives');
  assert.equal(matchesAccelerator('Cmd+Q', press('q', 'KeyQ')), false, 'no modifier');
  assert.equal(matchesAccelerator('Cmd+Q', press('q', 'KeyQ', { meta: true, shift: true })), false, 'one modifier too many');
  assert.equal(matchesAccelerator('Cmd+Q', press('q', 'KeyQ', { control: true })), false, 'another modifier');
  // each modifier on its own: one that is held and is not in the accelerator, and one that is in the accelerator and is not held
  for (const extra of ['meta', 'control', 'alt', 'shift'] as const) {
    assert.equal(matchesAccelerator('Ctrl+Alt+Shift+Cmd+K', press('k', 'KeyK', { control: true, alt: true, shift: true, meta: true })), true, 'all four');
    assert.equal(matchesAccelerator('Ctrl+Alt+Shift+Cmd+K', press('k', 'KeyK', { control: true, alt: true, shift: true, meta: true, [extra]: false })), false, `${extra} is in the accelerator and not held`);
    assert.equal(matchesAccelerator('K', press('k', 'KeyK', { [extra]: true })), false, `${extra} is held and not in the accelerator`);
  }
  assert.equal(matchesAccelerator('Cmd+Q', press('w', 'KeyW', { meta: true })), false, 'another key');
  assert.equal(matchesAccelerator('Ctrl+Cmd+F', press('f', 'KeyF', { control: true, meta: true })), true);
  assert.equal(matchesAccelerator('Ctrl+Cmd+F', press('f', 'KeyF', { meta: true })), false);
  assert.equal(matchesAccelerator('Ctrl+Alt+Shift+K', press('K', 'KeyK', { control: true, alt: true, shift: true })), true);
  assert.equal(matchesAccelerator('Ctrl+Alt+Shift+K', press('K', 'KeyK', { control: true, alt: true })), false);
  assert.equal(matchesAccelerator('F11', press('F11', 'F11')), true);
  assert.equal(matchesAccelerator('F11', press('F11', 'F11', { shift: true })), false);
  assert.equal(matchesAccelerator('F11', press('F10', 'F10')), false);
  for (const f of ['F1', 'F9', 'F12']) assert.equal(matchesAccelerator(f, press(f, f)), true, `${f} is a key`);
  assert.equal(matchesAccelerator('Cmd+1', press('1', 'Digit1', { meta: true })), true);
  assert.equal(matchesAccelerator('Cmd+1', press('2', 'Digit2', { meta: true })), false);
});

test('a letter is matched by what the key says, so that a keyboard layout whose keys sit elsewhere works; only when the modifiers made it another character is the place of the key used', () => {
  // AZERTY: the key that sits where Q is on a US keyboard says "a", and the key that says "q" has the code of A
  assert.equal(matchesAccelerator('Cmd+Q', press('q', 'KeyA', { meta: true })), true, 'the key that says q');
  assert.equal(matchesAccelerator('Cmd+Q', press('a', 'KeyQ', { meta: true })), false, 'the key that sits where Q is, but says a');
  // Option makes the character of a key another one on macOS: the place of the key says which it is
  assert.equal(matchesAccelerator('Ctrl+Alt+Cmd+K', press('˚', 'KeyK', { control: true, alt: true, meta: true })), true);
  assert.equal(matchesAccelerator('Ctrl+Alt+Cmd+K', press('˚', 'KeyJ', { control: true, alt: true, meta: true })), false);
  assert.equal(matchesAccelerator('Shift+Cmd+1', press('!', 'Digit1', { shift: true, meta: true })), true);
});

// Review of the execution (22 October 2026): the place of the key was used whenever the character was not a plain letter or digit, and that took keys that were never meant: on Dvorak the key that sits where Q is
// says an apostrophe, and with Cmd it is not Cmd+Q; on Windows and Linux Ctrl+Alt is AltGr, which types a character of its own (and that character must reach the session, not release the keyboard).
test('the place of the key is read only when Option on macOS, or Shift for a digit, made the character another one: not for a layout whose key sits elsewhere, not for AltGr', () => {
  // Dvorak: the key at the place of Q says an apostrophe, and Cmd with it is the apostrophe, not quitting; the key at the place of 1 says a slash
  assert.equal(matchesAccelerator('Cmd+Q', press("'", 'KeyQ', { meta: true })), false, 'Dvorak, the key at the place of Q');
  assert.equal(matchesAccelerator('Cmd+1', press('/', 'Digit1', { meta: true })), false, 'the key at the place of 1');
  assert.equal(reservedCommand('darwin', press("'", 'KeyQ', { meta: true })), undefined);
  // Option on macOS: the character is another one (a ring for K) and the place says which key it is; Shift makes a digit another character
  assert.equal(matchesAccelerator('Ctrl+Alt+Cmd+K', press('˚', 'KeyK', { control: true, alt: true, meta: true })), true);
  assert.equal(matchesAccelerator('Shift+Cmd+1', press('!', 'Digit1', { shift: true, meta: true })), true);
  assert.equal(matchesAccelerator('Shift+Cmd+K', press('˚', 'KeyK', { shift: true, meta: true })), false, 'Shift does not make another character of a letter: that character is not from Shift');
  // a plain letter or digit that says another letter or digit is that one: the place of the key is not asked
  assert.equal(matchesAccelerator('Alt+Cmd+N', press('l', 'KeyN', { alt: true, meta: true })), false, 'a plain letter that says another letter, with Option held');
  assert.equal(matchesAccelerator('Shift+Cmd+1', press('2', 'Digit1', { shift: true, meta: true })), false, 'a plain digit that says another digit, with Shift held');
  // AltGr on Windows and Linux is Ctrl and Alt together: a layout whose AltGr+Shift+K types a character of its own keeps that character, and the key is not the one that gives the keyboard back
  const altGr = press('ķ', 'KeyK', { control: true, alt: true, shift: true });
  assert.equal(matchesAccelerator('Ctrl+Alt+Shift+K', altGr), false, 'AltGr typed a character');
  assert.equal(reservedCommand('win32', altGr), undefined);
  assert.equal(reservedCommand('linux', altGr), undefined);
  assert.equal(reservedCommand('win32', press('K', 'KeyK', { control: true, alt: true, shift: true })), 'session.release', 'the plain chord still is');
});

test('an accelerator that is not one of the shapes this application writes is an error and not a key that never matches', () => {
  for (const wrong of ['', 'Cmd+', 'Meta+Q', 'Super+Q', 'CmdOrCtrl+Q', 'Cmd+Return', 'Ctrl+Tab', 'Cmd+Shift', 'Cmd+QQ', 'F25']) assert.throws(() => matchesAccelerator(wrong, press('q', 'KeyQ', { meta: true })), /not a key/, wrong);
});

test('the keys that stay the application\'s while a session holds the keyboard are found in a key press, for each platform, and nothing else is', () => {
  assert.equal(reservedCommand('darwin', press('q', 'KeyQ', { meta: true })), 'app.quit');
  assert.equal(reservedCommand('darwin', press('f', 'KeyF', { control: true, meta: true })), 'view.fullscreen');
  assert.equal(reservedCommand('darwin', press('˚', 'KeyK', { control: true, alt: true, meta: true })), 'session.release');
  assert.equal(reservedCommand('win32', press('K', 'KeyK', { control: true, alt: true, shift: true })), 'session.release');
  assert.equal(reservedCommand('linux', press('K', 'KeyK', { control: true, alt: true, shift: true })), 'session.release');
  // the session's own on Windows and Linux
  assert.equal(reservedCommand('win32', press('F11', 'F11')), undefined, 'F11 reaches the session');
  assert.equal(reservedCommand('win32', press('q', 'KeyQ', { control: true })), undefined, 'and so does Ctrl+Q');
  assert.equal(reservedCommand('linux', press('f', 'KeyF', { control: true, meta: true })), undefined);
  // and the system\'s own keys on macOS are not found here: they are kept by the menu (hide, minimize), not taken
  for (const other of [press('h', 'KeyH', { meta: true }), press('m', 'KeyM', { meta: true }), press('w', 'KeyW', { meta: true }), press('s', 'KeyS', { meta: true }), press('q', 'KeyQ', { meta: true, shift: true }), press('a', 'KeyA')]) assert.equal(reservedCommand('darwin', other), undefined, other.key);
});

test('every key that is reserved is one this matcher knows how to read, and is the key the command has', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as Platform[]) {
    for (const id of RESERVED_IN_CAPTURE[platform]) {
      const command = COMMANDS.find((c) => c.id === id)!;
      const key = keysFor(command, platform);
      if (key === undefined) continue;     // a command with no key on this platform cannot be reached by one
      const parts = key.split('+');
      const main = parts.pop()!;
      const input = press(main.length === 1 ? main.toLowerCase() : main, main.length === 1 ? `Key${main}` : main, { meta: parts.includes('Cmd'), control: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift') });
      assert.equal(reservedCommand(platform, input), id, `${platform} ${id} ${key}`);
    }
  }
});
