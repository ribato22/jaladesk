// The tabs of the sessions in the window: a tab is moved with the pointer (press on it, move sideways, let go where it should go), with Alt and the arrows when it has the focus (as an object is moved in the
// tree), and from the menu (tab.moveLeft, tab.moveRight). What the order is, where a dragged tab lands, and what is said afterwards are plain functions (tab-order.ts); this file is the glue that makes them
// buttons of the page. The order of the buttons in the page is the one order there is: the menu (Pilih Tab), the report of the window and the choice of the tab that comes after a closed one all read it.
// A tab that was dragged is not chosen by the click that ends the drag, and a press that only wobbles is a click like any other. A drag that loses its end (the button is let go outside the strip, over a menu of the
// system, or the tab is closed meanwhile) is over at the next thing that happens: the pointer moving with no button held, a new press, the loss of the capture of the pointer. Escape cancels a drag.
import { dropIndex, edgeWords, isDrag, movedWords, moveKeyDelta, moveTab, shiftTab } from './tab-order.js';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bar = () => el('tabs');
const tabButtons = () => [...bar().querySelectorAll<HTMLButtonElement>('button')];
/** The ids of the tabs in the order they are shown. */
export const tabIds = (): string[] => tabButtons().map((button) => button.dataset.id ?? '');

/** Puts a tab where it goes among the others; keeps the focus on it if it had it, brings it into sight and says where it is now. Says whether the order changed. */
function place(button: HTMLButtonElement, to: number): boolean {
  const id = button.dataset.id ?? '';
  const before = tabIds();
  const after = moveTab(before, id, to);
  if (after.join() === before.join()) return false;
  const held = document.activeElement === button;
  const others = tabButtons().filter((other) => other !== button);
  bar().insertBefore(button, others[after.indexOf(id)] ?? null);
  if (held) button.focus();
  button.scrollIntoView({ block: 'nearest', inline: 'nearest' });      // a strip with more tabs than fit: the tab that was moved is in sight
  el('tabs-live').textContent = movedWords(button.textContent ?? '', after.indexOf(id), after.length);
  return true;
}
function shift(button: HTMLButtonElement, delta: -1 | 1): boolean {
  const id = button.dataset.id ?? '';
  const ids = tabIds();
  const to = shiftTab(ids, id, delta).indexOf(id);
  if (place(button, to)) return true;
  el('tabs-live').textContent = edgeWords(button.textContent ?? '', ids.indexOf(id), ids.length, delta);      // it did not move, it is at an end: a person who cannot see the strip is told so and not left without an answer
  return false;
}
/** Moves the tab in front one place to the left (-1) or to the right (1): the commands of the menu. */
export function moveActive(delta: -1 | 1): boolean {
  const active = bar().querySelector<HTMLButtonElement>('button.active');
  return active ? shift(active, delta) : false;
}

export function initTabs(): void {
  const nav = bar();
  type Drag = { button: HTMLButtonElement; pointerId: number; startX: number; active: boolean; cancelled: boolean };
  let drag: Drag | undefined;
  const centers = (others: readonly HTMLButtonElement[]) => others.map((other) => { const r = other.getBoundingClientRect(); return r.left + r.width / 2; });
  const clearMarks = () => { for (const other of tabButtons()) other.classList.remove('drop-before', 'drop-after'); };
  function mark(others: readonly HTMLButtonElement[], to: number): void {
    clearMarks();
    if (to < others.length) others[to]!.classList.add('drop-before'); else others.at(-1)?.classList.add('drop-after');
  }
  /** The tab stops looking dragged: no mark, no cursor of dragging. */
  function plain(): void {
    drag?.button.classList.remove('dragging');
    nav.classList.remove('reordering');
    clearMarks();
  }
  /** The click that ends a drag is not a choice of the tab. */
  function swallowClick(): void {
    const swallow = (click: Event) => { click.stopImmediatePropagation(); click.preventDefault(); };
    nav.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => nav.removeEventListener('click', swallow, true), 0);
  }
  function end(): void {
    if (drag?.active) {
      plain();
      if (drag.button.hasPointerCapture(drag.pointerId)) drag.button.releasePointerCapture(drag.pointerId);
    }
    drag = undefined;
  }

  nav.addEventListener('pointerdown', (event) => {
    end();      // a drag whose end was lost is over
    const button = (event.target as Element).closest('button');
    if (event.button !== 0 || event.ctrlKey || !button || !nav.contains(button) || tabButtons().length < 2) return;      // Ctrl and a press is a click of the right button on the Mac
    drag = { button, pointerId: event.pointerId, startX: event.clientX, active: false, cancelled: false };
  });
  nav.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if ((event.buttons & 1) === 0 || !drag.button.isConnected) { end(); return; }      // the release was lost, or the tab is gone
    if (drag.cancelled) return;
    if (!drag.active) {
      if (!isDrag(event.clientX - drag.startX)) return;
      drag.active = true;
      drag.button.setPointerCapture(event.pointerId);
      drag.button.classList.add('dragging');
      nav.classList.add('reordering');
    }
    const others = tabButtons().filter((other) => other !== drag!.button);
    mark(others, dropIndex(centers(others), event.clientX));
  });
  nav.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.active) {
      swallowClick();
      if (!drag.cancelled) {
        const others = tabButtons().filter((other) => other !== drag!.button);
        place(drag.button, dropIndex(centers(others), event.clientX));
      }
    }
    end();
  });
  nav.addEventListener('pointercancel', end);
  document.addEventListener('lostpointercapture', end);      // also when the tab that held the capture was closed: the event is then the document's
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !drag?.active || drag.cancelled) return;
    event.preventDefault();
    drag.cancelled = true;      // the drag is over; what is left is the release of the button, and the click it makes is not a choice either
    plain();
  });
  nav.addEventListener('keydown', (event) => {
    const delta = moveKeyDelta(event);
    const button = (event.target as Element).closest('button');
    if (delta === undefined || !button || !nav.contains(button)) return;
    event.preventDefault();
    shift(button, delta);
  });
}
