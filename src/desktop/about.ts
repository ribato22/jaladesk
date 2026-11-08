// The dialog About, as plain data (like the questions of the main process: documents-ipc.ts), so that what it says can be tested without a window. It tells what the application is and what it
// runs on, from the fields of the process, each on a line of its own; a field is made into one line (a line break in it becomes a space), so that nothing can add lines to the dialog.

export type AboutInfo = { name: string; version: string; electron: string; chrome: string; node: string; platform: string; arch: string };
/** A dialog with nothing to choose: the button that Enter and Escape press is the only one. */
export type AboutNotice = { type: 'info'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };

const NAMES: Readonly<Record<string, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
export function platformName(platform: string): string { return Object.hasOwn(NAMES, platform) ? NAMES[platform]! : platform; }
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function aboutNotice(info: AboutInfo): AboutNotice {
  return {
    type: 'info',
    message: `Tentang ${oneLine(info.name)}`,
    detail: [`Versi ${oneLine(info.version)}`, `Electron ${oneLine(info.electron)} · Chromium ${oneLine(info.chrome)} · Node.js ${oneLine(info.node)}`, `${platformName(oneLine(info.platform))} ${oneLine(info.arch)}`].join('\n'),
    buttons: ['Tutup'],
    defaultId: 0,
    cancelId: 0,
  };
}
