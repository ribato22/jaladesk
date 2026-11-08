const {contextBridge,ipcRenderer}=require('electron');
function listen(name,callback){const fn=(_event,value)=>callback(value);ipcRenderer.on(name,fn);return ()=>ipcRenderer.removeListener(name,fn);}
contextBridge.exposeInMainWorld('rdp',{
  info:()=>ipcRenderer.invoke('rdp:info'),open:target=>ipcRenderer.invoke('rdp:open',target),
  openStored:ref=>ipcRenderer.invoke('rdp:open-stored',ref),reconnectStored:id=>ipcRenderer.invoke('rdp:reconnect-stored',id),forgetStored:id=>ipcRenderer.invoke('rdp:forget-stored',id),
  input:(id,input)=>ipcRenderer.invoke('rdp:input',id,input),close:id=>ipcRenderer.invoke('rdp:close',id),
  activate:id=>ipcRenderer.invoke('rdp:activate',id),clipboardSync:id=>ipcRenderer.invoke('rdp:clipboard-sync',id),
  onFrame:callback=>listen('rdp:frame',value=>{try{callback(value);}finally{ipcRenderer.send('rdp:frame-ack',value.id,value.sequence);}}),onState:callback=>listen('rdp:state',callback),onStoredOpened:callback=>listen('rdp:bulk-opened',callback)
});
// Documents: the renderer asks, the main process shows the dialogs; no argument here is a path or a password.
contextBridge.exposeInMainWorld('documents',{
  views:()=>ipcRenderer.invoke('documents:views'),create:name=>ipcRenderer.invoke('documents:create',{name}),open:()=>ipcRenderer.invoke('documents:open'),
  add:input=>ipcRenderer.invoke('documents:add',input),update:input=>ipcRenderer.invoke('documents:update',input),remove:input=>ipcRenderer.invoke('documents:remove',input),
  save:id=>ipcRenderer.invoke('documents:save',{id}),close:id=>ipcRenderer.invoke('documents:close',{id}),
  snapshot:id=>ipcRenderer.invoke('documents:snapshot',{id}),move:input=>ipcRenderer.invoke('documents:move',input),duplicate:input=>ipcRenderer.invoke('documents:duplicate',input),favorite:input=>ipcRenderer.invoke('documents:favorite',input),
  openRecent:index=>ipcRenderer.invoke('documents:open-recent',{index}),forgetKey:id=>ipcRenderer.invoke('documents:forget-key',{id}),
  conflicts:id=>ipcRenderer.invoke('documents:conflicts',{id}),resolve:input=>ipcRenderer.invoke('documents:resolve',input),reload:id=>ipcRenderer.invoke('documents:reload',{id}),
  revisions:id=>ipcRenderer.invoke('documents:revisions',{id}),revision:input=>ipcRenderer.invoke('documents:revision',input),restore:input=>ipcRenderer.invoke('documents:restore',input),autosave:input=>ipcRenderer.invoke('documents:autosave',input),
  onRefresh:callback=>listen('documents:refresh',()=>callback()),onDelta:callback=>listen('documents:delta',callback),onEvent:callback=>listen('documents:event',callback)
});
// The shell: what the window can do now is reported (nothing comes back); the settings are asked for and the toolbar is changed; the commands that belong to the main process are asked for by id.
contextBridge.exposeInMainWorld('shell',{
  report:value=>ipcRenderer.send('shell:report',value),settings:()=>ipcRenderer.invoke('shell:settings'),setToolbar:patch=>ipcRenderer.invoke('shell:set-toolbar',patch),run:id=>ipcRenderer.invoke('shell:run',{id}),
  view:()=>ipcRenderer.invoke('shell:view'),context:request=>ipcRenderer.send('shell:context',request),
  onCommand:callback=>listen('shell:command',callback),onSettings:callback=>listen('shell:settings-changed',callback),onNotice:callback=>listen('shell:notice',callback),onViewChanged:callback=>listen('shell:view-changed',callback)
});

contextBridge.exposeInMainWorld('workspace',{run:(action,input)=>ipcRenderer.invoke('workspace:run',action,input)});
