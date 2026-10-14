const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('credential',{submit:value=>ipcRenderer.send('credential:submit',value)});
