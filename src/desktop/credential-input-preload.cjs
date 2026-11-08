const { contextBridge, ipcRenderer } = require('electron');
let binding, consumed = false;
contextBridge.exposeInMainWorld('credentialInput', {
  onRequest: callback => ipcRenderer.once('credential-input:request', (_event, value) => {
    if (!value || typeof value.promptId !== 'string' || !Number.isSafeInteger(value.generation) || typeof value.nonce !== 'string' || !Number.isFinite(value.expiresAt)) return;
    binding = { promptId: value.promptId, generation: value.generation, nonce: value.nonce };
    callback({ ...binding, expiresAt: value.expiresAt, label: typeof value.label === 'string' ? value.label : '', purpose: ['edit','inline','protected'].includes(value.purpose)?value.purpose:'create', ...(value.initial&&typeof value.initial.username==='string'&&typeof value.initial.domain==='string'&&typeof value.initial.hasPassword==='boolean'&&typeof value.initial.hasTotp==='boolean'?{initial:{username:value.initial.username,domain:value.initial.domain,hasPassword:value.initial.hasPassword,hasTotp:value.initial.hasTotp}}:{}) });
  }),
  onClear: callback => ipcRenderer.on('credential-input:clear', () => { consumed = true; binding = undefined; callback(); }),
  submit: value => {
    if (consumed || !binding || !value) return;
    consumed = true;
    const payload = { ...binding, username: value.username, domain: value.domain, passwordAction: value.passwordAction, ...(value.passwordAction === 'replace' ? { password: value.password } : {}) };
    for(const key of ['totp','privateKey','passphrase']){if(['keep','replace','remove'].includes(value[key+'Action'])){payload[key+'Action']=value[key+'Action'];if(value[key+'Action']==='replace')payload[key]=value[key];}}
    if(['replace','remove'].includes(value.protectedAction)){payload.protectedAction=value.protectedAction;if(value.protectedAction==='replace')payload.protectedValue=value.protectedValue;}
    binding = undefined; ipcRenderer.send('credential-input:submit', payload);
  },
  cancel: () => { if (!consumed && binding) { consumed = true; const payload = binding; binding = undefined; ipcRenderer.send('credential-input:cancel', payload); } }
});
