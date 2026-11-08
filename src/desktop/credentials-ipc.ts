import { randomBytes } from 'node:crypto';
import {validateSecret} from '../documents/schema-v2.js';
import type {Json,PrivateKey,TotpConfig} from '../documents/model.js';

export interface CredentialInput { username: string; domain: string; passwordAction: 'keep' | 'replace' | 'remove'; password?: string; totpAction?:'keep'|'replace'|'remove';totp?:TotpConfig;privateKeyAction?:'keep'|'replace'|'remove';privateKey?:PrivateKey;passphraseAction?:'keep'|'replace'|'remove';passphrase?:string;protectedAction?:'replace'|'remove';protectedValue?:Json }
export type CredentialInputInitial={username:string;domain:string;hasPassword:boolean;hasTotp:boolean};
export type CredentialInputPurpose='create'|'edit'|'inline'|'protected';
export interface CredentialInputEvent { senderId: number; origin: string; mainFrame: unknown }
export interface CredentialInputPublicRequest { promptId: string; generation: number; nonce: string; expiresAt: number; label: string; purpose: CredentialInputPurpose; initial?:CredentialInputInitial }
export interface CredentialInputHost {
  open(request: CredentialInputPublicRequest, submit: (event: CredentialInputEvent, payload: unknown, currentGeneration: number) => void, cancel: (event?: CredentialInputEvent, payload?: unknown) => void): CredentialInputEvent & { clear(): void; close(): void };
  now?(): number;
  randomNonce?(): string;
  setTimer?(callback: () => void, milliseconds: number): unknown;
  clearTimer?(timer: unknown): void;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** The host supplies a private input window; this guard never provides stored values to that window. */
export function requestCredentialInput(options: { binding: { promptId: string; generation: number }; label: string; purpose: CredentialInputPurpose; initial?:CredentialInputInitial; timeoutMs?: number }, host: CredentialInputHost): Promise<CredentialInput | undefined> {
  const timeout = options.timeoutMs ?? 120000; const now = host.now ?? Date.now;
  if (typeof options.binding?.promptId !== 'string' || !options.binding.promptId || options.binding.promptId.length > 128 || !Number.isSafeInteger(options.binding.generation) || options.binding.generation < 0 || typeof options.label !== 'string' || options.label.length > 512 || !['create', 'edit','inline','protected'].includes(options.purpose) || !Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) throw new Error('Permintaan input tidak valid');
  if(options.initial!==undefined&&(!record(options.initial)||Object.keys(options.initial).some(k=>!['username','domain','hasPassword','hasTotp'].includes(k))||typeof options.initial.username!=='string'||options.initial.username.length>256||typeof options.initial.domain!=='string'||options.initial.domain.length>256||typeof options.initial.hasPassword!=='boolean'||typeof options.initial.hasTotp!=='boolean'))throw new Error('Permintaan input tidak valid');
  const request: CredentialInputPublicRequest = { ...options.binding, label: options.label, purpose: options.purpose, ...(options.initial?{initial:{...options.initial}}:{}), nonce: host.randomNonce?.() ?? randomBytes(32).toString('hex'), expiresAt: now() + timeout };
  if (!/^[a-f0-9]{64}$/.test(request.nonce)) throw new Error('Permintaan input tidak valid');
  return new Promise((resolve) => {
    let done = false; let window: ReturnType<CredentialInputHost['open']> | undefined; let timer: unknown;
    const finish = (value?: CredentialInput) => {
      if (done) return; done = true;
      if (timer !== undefined) { if (host.clearTimer) host.clearTimer(timer); else clearTimeout(timer as ReturnType<typeof setTimeout>); }
      try { window?.clear(); } catch { /* A disposed input window is already clear. */ }
      try { window?.close(); } catch { /* A closed window needs no second close. */ }
      resolve(value);
    };
    const authorized = (event: CredentialInputEvent) => !!window && event.senderId === window.senderId && event.origin === window.origin && event.mainFrame === window.mainFrame;
    const bound = (payload: unknown): payload is Record<string, unknown> => record(payload) && payload.promptId === request.promptId && payload.generation === request.generation && payload.nonce === request.nonce;
    const submit = (event: CredentialInputEvent, payload: unknown, currentGeneration: number) => {
      if (done || !authorized(event) || !bound(payload)) return;
      if (now() >= request.expiresAt || currentGeneration !== request.generation) { finish(); return; }
      const keys = ['promptId', 'generation', 'nonce', 'username', 'domain', 'passwordAction', 'password','totpAction','totp','privateKeyAction','privateKey','passphraseAction','passphrase','protectedAction','protectedValue'];
      const action = payload.passwordAction;
      if (Object.keys(payload).some((key) => !keys.includes(key)) || typeof payload.username !== 'string' || payload.username.length > 256 || typeof payload.domain !== 'string' || payload.domain.length > 256 || !['keep', 'replace', 'remove'].includes(action as string) || (['create','inline'].includes(options.purpose) && action === 'keep') || (action === 'replace' ? typeof payload.password !== 'string' || payload.password.length > 65536 : Object.hasOwn(payload, 'password'))) { finish(); return; }
      const extra:Record<string,unknown>={};
      try {
        if(options.purpose==='protected'){
          if(!['replace','remove'].includes(payload.protectedAction as string)||payload.username!==''||payload.domain!==''||action!=='remove'||Object.keys(payload).some(k=>['totpAction','totp','privateKeyAction','privateKey','passphraseAction','passphrase'].includes(k)))throw new Error();
          if(payload.protectedAction==='replace'){validateSecret({kind:'protected-value',value:payload.protectedValue});extra.protectedValue=structuredClone(payload.protectedValue);}else if(Object.hasOwn(payload,'protectedValue'))throw new Error();
          extra.protectedAction=payload.protectedAction;
        }else{
          if(Object.hasOwn(payload,'protectedAction')||Object.hasOwn(payload,'protectedValue'))throw new Error();
          const check:Record<string,unknown>={kind:'credential',username:payload.username,domain:payload.domain};
          for(const key of ['totp','privateKey','passphrase']){
            const keyAction=payload[key+'Action'];
            if(keyAction!==undefined&&!['keep','replace','remove'].includes(keyAction as string))throw new Error();
            if(keyAction==='replace'){check[key]=payload[key];extra[key]=structuredClone(payload[key]);}else if(Object.hasOwn(payload,key))throw new Error();
            if(keyAction!==undefined)extra[key+'Action']=keyAction;
          }validateSecret(check);
        }
      }catch{finish();return;}
      finish({ username: payload.username, domain: payload.domain, passwordAction: action as CredentialInput['passwordAction'], ...(action === 'replace' ? { password: payload.password as string } : {}),...extra });
    };
    const cancel = (event?: CredentialInputEvent, payload?: unknown) => { if (!event || (authorized(event) && bound(payload))) finish(); };
    try {
      window = host.open({ ...request }, submit, cancel);
      if (!Number.isSafeInteger(window.senderId) || window.senderId < 1 || typeof window.origin !== 'string' || !window.origin || !window.mainFrame) { finish(); return; }
      if (done) { window.clear(); window.close(); return; }
      timer = host.setTimer ? host.setTimer(() => finish(), timeout) : setTimeout(() => finish(), timeout);
    } catch { finish(); }
  });
}
