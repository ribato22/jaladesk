const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('password',{
  submit:value=>ipcRenderer.send('password:submit',value),cancel:()=>ipcRenderer.send('password:cancel'),
  onRequest:callback=>ipcRenderer.once('password:request',(_event,value)=>callback({purpose:value?.purpose==='create'?'create':'open',name:String(value?.name),error:value?.error===undefined?'':String(value.error),minLength:Number(value?.minLength)||1,maxBytes:Number(value?.maxBytes)||1024,rememberable:value?.rememberable===true,remember:value?.remember===true}))
});
