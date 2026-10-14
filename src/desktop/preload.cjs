const {contextBridge,ipcRenderer}=require('electron');
function listen(name,callback){const fn=(_event,value)=>callback(value);ipcRenderer.on(name,fn);return ()=>ipcRenderer.removeListener(name,fn);}
contextBridge.exposeInMainWorld('rdp',{
  info:()=>ipcRenderer.invoke('rdp:info'),open:target=>ipcRenderer.invoke('rdp:open',target),
  input:(id,input)=>ipcRenderer.invoke('rdp:input',id,input),close:id=>ipcRenderer.invoke('rdp:close',id),
  onFrame:callback=>listen('rdp:frame',value=>{try{callback(value);}finally{ipcRenderer.send('rdp:frame-ack',value.id,value.sequence);}}),onState:callback=>listen('rdp:state',callback)
});
