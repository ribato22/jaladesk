// The one order in which the children of a folder are shown. The main process uses it where an operation says "at position 3" and the window uses
// it to draw the rows, so both always mean the same sibling. Manual order first; equal orders by name, ignoring case and reading digits as
// numbers (srv2 before srv10); then by id, so the result never depends on the order the objects arrive in.
import type { ObjectNode } from './model.js';

const names = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
/** Two names as a person reads them: without regard to case or accents, digits as numbers (srv2 before srv10). */
export const compareNames = (a: string, b: string): number => names.compare(a, b);
export const compareSiblings = (a: ObjectNode, b: ObjectNode): number => a.order - b.order || compareNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
