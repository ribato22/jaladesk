import type { ObjectNode, SecretRecord, Doc } from '../documents/model.js';
export type CredentialView = { id: string; name: string; username: string; domain: string; hasPassword: boolean; hasTotp: boolean; status: 'ready' | 'missing' };
export function credentialRecord(doc: Doc, node: ObjectNode): Extract<SecretRecord,{kind:'credential'}> | undefined {
  if (doc.schemaVersion !== 2 || node.type !== 'credential' || typeof node.props.secretId !== 'string' || !Object.hasOwn(doc.secrets,node.props.secretId)) return undefined;
  const record=doc.secrets[node.props.secretId];return record.kind==='credential'?record:undefined;
}
export function credentialView(doc: Doc, node: ObjectNode): CredentialView {
  const record=credentialRecord(doc,node);
  return {id:node.id,name:node.name,username:record?.username??'',domain:record?.domain??'',hasPassword:record?.password!==undefined,hasTotp:record?.totp!==undefined,status:record?'ready':'missing'};
}
/** Fixed codes only: Error.cause and arbitrary fields can contain input or third-party diagnostics. */
export function redactCredentialError(error: unknown): { code: string } {
  const code=(error as {code?:unknown})?.code;
  return {code:typeof code==='string'&&['missing','locked','stale','scope-denied','ambiguous','invalid','cancelled','upgrade-required','not-supported','busy'].includes(code)?code:'credential-error'};
}
