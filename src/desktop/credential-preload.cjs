const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('credential',{submit:value=>ipcRenderer.send('credential:submit',value),onTarget:callback=>ipcRenderer.once('credential:target',(_event,value)=>callback({label:String(value?.label),clipboard:String(value?.clipboard)}))});
