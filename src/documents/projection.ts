import type { Json, ObjectNode } from './model.js';
import { isGroup, projectGroup } from './groups.js';

const text = ['protocol', 'host', 'username', 'certificateSha256', 'notes', 'color', 'icon'];
const flags = ['clipboardToRemote', 'clipboardFromRemote'];
export const writablePublicProperty = (key: string): boolean => [...text, ...flags, 'port', 'sort'].includes(key);
export function publicPropertyValue(key: string, value: Json | undefined): boolean {
  if (value === undefined) return true;
  if (text.includes(key)) return typeof value === 'string';
  if (flags.includes(key)) return typeof value === 'boolean';
  if (key === 'port') return typeof value === 'number' && Number.isFinite(value);
  return key === 'sort' && Array.isArray(value) && value.length <= 2 && value.every(v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && ['name','type'].includes(String(v.by)) && ['asc','desc'].includes(String(v.dir)));
}
export const publicConflictField = (field: string, sides: readonly (Json | undefined)[]): boolean => field.startsWith('props.') && writablePublicProperty(field.slice(6)) && sides.every(v=>publicPropertyValue(field.slice(6),v));

/** Unknown properties stay encrypted in the document and do not become public when a new writer adds them. */
export function projectNode(node: ObjectNode): ObjectNode | undefined {
  if (node.type !== 'folder' && node.type !== 'connection') return undefined;
  const props: Record<string, Json> = {};
  for (const key of [...text,...flags,'port','sort']) if (Object.hasOwn(node.props,key) && publicPropertyValue(key,node.props[key])) props[key]=structuredClone(node.props[key]);
  const groups = node.props.groups;
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    const safe: Record<string, Json> = {};
    for (const [key,value] of Object.entries(groups)) if (isGroup(key)) safe[key] = projectGroup(key,value);
    props.groups = safe;
  }
  const inherit = node.props.inherit;
  if (inherit && typeof inherit === 'object' && !Array.isArray(inherit)) props.inherit = Object.fromEntries(Object.entries(inherit).filter(([key,value]) => isGroup(key) && typeof value === 'boolean'));
  return { id: node.id, type: node.type, name: node.name, parentId: node.parentId, order: node.order, props };
}
export const projectNodes = (nodes: Iterable<ObjectNode>): ObjectNode[] => Array.from(nodes).flatMap(node => { const safe=projectNode(node); return safe ? [safe] : []; });
