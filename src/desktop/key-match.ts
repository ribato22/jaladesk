// Which key a key press is. The keys of the menu are taken by the system and by the page in an order that this application does not control (the page is offered a key before the menu, and the screen of
// a connected session consumes every key), so the few keys that must work whatever the page does while a session holds the keyboard are recognised by the main process before the page sees them
// (before-input-event). This file is only the recognising: it knows the shape of the key press of Electron and of the accelerators this application writes (modifiers Cmd, Ctrl, Alt and Shift, then a
// letter, a digit or an F key), and nothing of Electron itself.
import { COMMANDS, keysFor, type CommandId, type Platform } from './commands.js';
import { RESERVED_IN_CAPTURE } from './menu-model.js';

/** The part of the key press of Electron (`Input`) that is used: what kind of event, the character the key makes, the place of the key, whether it repeats, and the modifiers held. */
export type KeyInput = {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly isAutoRepeat: boolean;
  readonly shift: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
};

const MODIFIERS: readonly string[] = ['Cmd', 'Ctrl', 'Alt', 'Shift'];
const KEY = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/;
const isPlain = (key: string) => /^[a-z0-9]$/i.test(key);
/** Whether the modifiers may have made the key say another character: Option on macOS does (a ring for K), Ctrl and Alt together without Cmd is AltGr on Windows and Linux, which types a character of its own and says nothing about which key it was. */
const optionMade = (input: KeyInput) => input.alt && !(input.control && !input.meta);

/**
 * Whether a key press is the key that `accelerator` names, with exactly those modifiers. A letter or a digit is matched by the character the key makes (so a keyboard layout whose keys sit elsewhere
 * works: on Dvorak the key at the place of Q says an apostrophe, and Cmd with it is not Cmd+Q); only when the modifiers made it another character (Option on macOS, Shift for a digit) is the place of the
 * key used, and not when Ctrl and Alt without Cmd are AltGr (a character of its own, which is the session's). An accelerator of another shape than this application writes is an error, not a key that
 * never matches.
 */
export function matchesAccelerator(accelerator: string, input: KeyInput): boolean {
  const parts = accelerator.split('+');
  const main = parts.pop()!;
  if (!parts.every((part) => MODIFIERS.includes(part)) || !KEY.test(main)) throw new Error(`not a key this application writes: ${accelerator}`);
  if (input.meta !== parts.includes('Cmd') || input.control !== parts.includes('Ctrl') || input.alt !== parts.includes('Alt') || input.shift !== parts.includes('Shift')) return false;
  if (/^[A-Z]$/.test(main)) return input.key.toLowerCase() === main.toLowerCase() || (optionMade(input) && !isPlain(input.key) && input.code === `Key${main}`);
  if (/^[0-9]$/.test(main)) return input.key === main || ((optionMade(input) || input.shift) && !isPlain(input.key) && input.code === `Digit${main}`);
  return input.key === main;
}

/** Whether a key press closes a window that has no menu of its own to do it (the window of the settings): Cmd+W on the Mac, Ctrl+W elsewhere, pressed once. */
export function closesWindow(platform: Platform, input: KeyInput): boolean {
  return input.type === 'keyDown' && !input.isAutoRepeat && matchesAccelerator(platform === 'darwin' ? 'Cmd+W' : 'Ctrl+W', input);
}

/** The command, among those that keep their keys while a session holds the keyboard, that a key press is; nothing for any other key. */
export function reservedCommand(platform: Platform, input: KeyInput): CommandId | undefined {
  return RESERVED_IN_CAPTURE[platform].find((id) => {
    const key = keysFor(COMMANDS.find((command) => command.id === id)!, platform);
    return key !== undefined && matchesAccelerator(key, input);
  });
}
