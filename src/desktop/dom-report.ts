// What the window tells the main process (commands.ts: Report), worked out from the page. The buttons of the page already know when a command can be done (documents-ui.ts and
// safety-ui.ts switch them off and on as the selection and the document change), so the report is READ from them: a menu item, a toolbar button and the button of the page can never disagree,
// and none of the code that decides it had to be touched. The commands that no button stands for (finding, a tab, giving the keyboard back) are decided by the menu model from the few
// numbers here; the ones that belong to the main process are not reported at all.
// `Reader` is the page as this file needs it, so that the report can be tested with a plain object; shell-ui.ts gives it the real document.
import { COMMANDS, MAX_TABS, makeReport, type CommandId, type Report } from './commands.js';

export type Reader = {
  /** Whether the control with this id can be used: false when it is switched off, nothing when there is no such control. */
  enabled(id: string): boolean | undefined;
  /** Whether a toggle button is pressed (aria-pressed). */
  pressed(id: string): boolean;
  /** What a choice (the select for saving by itself) holds now. */
  value(id: string): string | undefined;
  /** How many tabs there are, and which one is in front (-1 when none is). */
  tabs(): { count: number; active: number };
  /** The state of the session in front, as the page publishes it: none, connecting, connected, closed or failed. */
  session(): string;
  /** Whether the focus is on the screen of a session (the element that takes the keys of the keyboard). */
  focusOnScreen(): boolean;
  /** Whether a dialog of the page is open. */
  dialogOpen(): boolean;
};

const AUTOSAVE = 'doc-autosave';
const MODES: Readonly<Record<string, CommandId>> = { off: 'doc.autosave.off', close: 'doc.autosave.close', edit: 'doc.autosave.edit' };

export function readReport(page: Reader): Report {
  const enabled = new Set<CommandId>(), checked = new Set<CommandId>();
  for (const command of COMMANDS) {
    if (command.button === undefined) continue;
    if (page.enabled(command.button) === true) enabled.add(command.id);
    if (command.id === 'obj.favorite' && page.pressed(command.button)) checked.add(command.id);
  }
  // the choice of saving by itself shows what it holds only when it can be made: a choice that is off shows nothing, so that nothing that may be wrong is shown
  const mode = page.enabled(AUTOSAVE) === true ? page.value(AUTOSAVE) : undefined;
  if (mode !== undefined && Object.hasOwn(MODES, mode)) checked.add(MODES[mode]!);
  const { count, active } = page.tabs();
  const tabs = Number.isFinite(count) ? Math.min(Math.max(Math.floor(count), 0), MAX_TABS) : 0;
  const tab = Number.isInteger(active) && active >= 0 && active < tabs ? active : -1;
  return makeReport({ enabled, checked, capture: page.session() === 'connected' && page.focusOnScreen(), dialog: page.dialogOpen(), tabs, tab });
}

/** The tab that Tab Berikutnya (delta 1) or Tab Sebelumnya (-1) goes to, around at the ends: nothing when there are fewer than two tabs. `at` is the tab in front, -1 when none is (it counts as the first). */
export function stepTab(at: number, count: number, delta: 1 | -1): number | undefined {
  return count < 2 ? undefined : (Math.max(at, 0) + delta + count) % count;
}
