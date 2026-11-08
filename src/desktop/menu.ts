// The menu of the model (menu-model.ts) as the template that Electron builds a real menu from. This is all the conversion there is: what the items say, which key does them, whether they can be
// chosen and whether they are on were decided by the model, and what a click does is handed in. An item of a command has the id of the command, so that a script or a test can find it by it
// (Menu.getMenuItemById); an item of the system's own has a role and nothing else (the system gives it its key and does what it does); an item that does nothing now is a plain item that is off.
import type { CommandId } from './commands.js';
import type { Entry } from './menu-model.js';

export type TemplateItem = {
  id?: string;
  label?: string;
  role?: string;
  accelerator?: string;
  enabled?: boolean;
  /** Only ever false: an item that is there and is not shown (a place for a recent document there is none for). */
  visible?: false;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  checked?: boolean;
  submenu?: TemplateItem[];
  click?: () => void;
};

export function toTemplate(entries: readonly Entry[], onCommand: (id: CommandId) => void): TemplateItem[] {
  return entries.map((entry): TemplateItem => {
    switch (entry.kind) {
      case 'separator': return { type: 'separator' };
      case 'command': return {
        id: entry.id, label: entry.label, ...(entry.accelerator !== undefined ? { accelerator: entry.accelerator } : {}), enabled: entry.enabled,
        type: entry.control ?? 'normal', ...(entry.control ? { checked: entry.checked === true } : {}), ...(entry.hidden ? { visible: false as const } : {}), click: () => onCommand(entry.id),
      };
      case 'role': return { role: entry.role, label: entry.label };
      case 'plain': return { label: entry.label, enabled: false };
      case 'submenu': return { label: entry.label, submenu: toTemplate(entry.items, onCommand) };
    }
  });
}
