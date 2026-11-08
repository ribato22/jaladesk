import { generatePassword } from '../credentials/hygiene.js';
import type { CredentialInput, CredentialInputPublicRequest } from './credentials-ipc.js';

export interface CredentialInputBridge {
  onRequest(callback: (request: CredentialInputPublicRequest) => void): void;
  onClear(callback: () => void): void;
  submit(value: CredentialInput): void;
  cancel(): void;
}

export function mountCredentialInput(doc: Document, bridge: CredentialInputBridge): () => void {
  const field = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const action = doc.getElementById('password-action') as HTMLSelectElement;
  let active = false; let protectedMode=false;
  const clear = () => { for (const id of ['password', 'username', 'domain','totp-secret','private-key-value','passphrase','protected-value']) {const input=field(id);if(input)input.value = '';} active = false; };
  bridge.onClear(clear); doc.defaultView?.addEventListener('pagehide', clear);
  bridge.onRequest((request) => {
    clear(); active = true; protectedMode=request.purpose==='protected';
    const normal=doc.getElementById('credential-fields'),protectedFields=doc.getElementById('protected-fields');if(normal)normal.hidden=protectedMode;if(protectedFields)protectedFields.hidden=!protectedMode;
    if(request.initial){field('username').value=request.initial.username;field('domain').value=request.initial.domain;}
    const status=doc.getElementById('existing-status');if(status)status.textContent=request.initial?(doc.defaultView?`Password: ${request.initial.hasPassword?'Set':'Empty'}; TOTP: ${request.initial.hasTotp?'Set':'Empty'}. Stored secret values are hidden.`:`Password: ${request.initial.hasPassword?'tersedia':'kosong'}; TOTP: ${request.initial.hasTotp?'tersedia':'kosong'}. Nilai rahasia tersimpan tidak ditampilkan.`):'';
    for(const id of ['totp-action','private-key-action','passphrase-action']){const select=field(id) as unknown as HTMLSelectElement;if(select){select.options[0]!.disabled=request.purpose!=='edit';select.value=request.purpose==='edit'?'keep':'remove';}}
    for(const id of ['totp-secret','private-key-value','passphrase'])if(field(id))field(id).disabled=true;
    if(field('totp-algorithm'))field('totp-algorithm').value='sha1';if(field('totp-digits'))field('totp-digits').value='6';if(field('totp-period'))field('totp-period').value='30';if(field('protected-action'))field('protected-action').value='replace';if(field('protected-value'))field('protected-value').disabled=false;
    doc.getElementById('input-error')!.textContent='';
    doc.getElementById('target')!.textContent = request.label;
    action.options[0]!.disabled = request.purpose !== 'edit';
    action.value = request.purpose === 'edit' ? 'keep' : 'replace'; field('password').disabled = action.value !== 'replace';
  });
  for(const [actionId,valueId] of [['totp-action','totp-secret'],['private-key-action','private-key-value'],['passphrase-action','passphrase'],['protected-action','protected-value']]){field(actionId)?.addEventListener('change',()=>{field(valueId)!.disabled=field(actionId)!.value!=='replace';if(field(valueId)!.disabled)field(valueId)!.value='';});}
  doc.addEventListener?.('keydown',event=>{if(event.key==='Escape'&&active){event.preventDefault();clear();bridge.cancel();}});
  action.addEventListener('change', () => { field('password').disabled = action.value !== 'replace'; if (action.value !== 'replace') field('password').value = ''; });
  doc.getElementById('generate')!.addEventListener('click', () => {
    if (!active) return;
    try {
      field('password').value = generatePassword({ length: Number(field('length').value), lowercase: field('lowercase').checked, uppercase: field('uppercase').checked, digits: field('digits').checked, symbols: field('symbols').checked, excludeAmbiguous: field('exclude-ambiguous').checked });
      action.value = 'replace'; field('password').disabled = false; doc.getElementById('input-error')!.textContent = '';
    } catch { doc.getElementById('input-error')!.textContent = doc.defaultView ? 'Invalid generator options or random source unavailable.' : 'Pilihan generator tidak valid atau sumber acak tidak tersedia.'; }
  });
  doc.getElementById('input-form')!.addEventListener('submit', (event) => {
    event.preventDefault(); if (!active) return;
    if (!['keep', 'replace', 'remove'].includes(action.value)) return;
    const passwordAction = action.value as CredentialInput['passwordAction'];
    let value:CredentialInput;
    try{
      if(protectedMode){const protectedAction=field('protected-action').value;if(!['replace','remove'].includes(protectedAction))return;value={username:'',domain:'',passwordAction:'remove',protectedAction:protectedAction as 'replace'|'remove',...(protectedAction==='replace'?{protectedValue:JSON.parse(field('protected-value').value)}:{})};}
      else{value={username:field('username').value,domain:field('domain').value,passwordAction,...(passwordAction==='replace'?{password:field('password').value}:{})};
        for(const [key,actionId] of [['totp','totp-action'],['privateKey','private-key-action'],['passphrase','passphrase-action']] as const){const action=field(actionId)?.value;if(action===undefined)continue;if(!['keep','replace','remove'].includes(action))return;(value as any)[key+'Action']=action;if(action==='replace'){if(key==='totp'){const secretBase32=field('totp-secret').value,algorithm=field('totp-algorithm').value,digits=Number(field('totp-digits').value),period=Number(field('totp-period').value);if(!/^[A-Z2-7]+={0,6}$/.test(secretBase32)||!['sha1','sha256','sha512'].includes(algorithm)||![6,8].includes(digits)||!Number.isInteger(period)||period<15||period>120)throw new Error();(value as any).totp={secretBase32,algorithm,digits,period};}else if(key==='privateKey'){const mode=field('private-key-mode').value,text=field('private-key-value').value;if(!text||!['path','embedded'].includes(mode))throw new Error();value.privateKey=mode==='path'?{mode,path:text}:{mode:'embedded',base64:text};}else value.passphrase=field('passphrase').value;}}
      }
    }catch{doc.getElementById('input-error')!.textContent=doc.defaultView?'Invalid value. Check JSON, TOTP seed, or private key.':'Nilai baru tidak valid. Periksa JSON, seed TOTP atau private key.';return;}
    try {bridge.submit(value);}finally{clear();}
  });
  doc.getElementById('cancel')!.addEventListener('click', () => { if (active) { clear(); bridge.cancel(); } });
  return clear;
}

if (typeof window !== 'undefined' && 'credentialInput' in window) mountCredentialInput(document, (window as unknown as { credentialInput: CredentialInputBridge }).credentialInput);
