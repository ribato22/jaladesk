const {contextBridge,ipcRenderer}=require('electron');
function listen(name,callback){const fn=(_event,value)=>callback(value);ipcRenderer.on(name,fn);return ()=>ipcRenderer.removeListener(name,fn);}
// The window of the settings: it asks for the settings and changes them one at a time; nothing in it is a path, a name of a document or a key.
contextBridge.exposeInMainWorld('settingsWindow',{
  get:()=>ipcRenderer.invoke('settings:get'),set:value=>ipcRenderer.invoke('settings:set',value),
  forgetKeys:()=>ipcRenderer.invoke('settings:forget-keys'),clearRecent:()=>ipcRenderer.invoke('settings:clear-recent'),
  onChanged:callback=>listen('settings:changed',callback)
});
