import {app,BrowserWindow,ipcMain,session as electronSession} from 'electron';
import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {mkdirSync} from 'node:fs';
import {makeOwner,ipcAllowed,type Session} from '../protocols/rdp/owner.js';
import {validateTarget,validateInput,type Secret} from '../protocols/rdp/wire.js';
const root=app.getAppPath(),scratch=resolve(root,'../../work/electron-user-data');mkdirSync(scratch,{recursive:true});
app.setName('Remote Workspace RDP');app.setPath('userData',scratch);
const fixture=process.argv.includes('--fixture');
const localUrl=pathToFileURL(join(root,'src/desktop/index.html')).href;
const credentialUrl=pathToFileURL(join(root,'src/desktop/credential.html')).href;
const helper=join(root,'native/bin',process.platform==='win32'?'rdp-bridge.exe':'rdp-bridge');
const owner=makeOwner((path,args)=>spawn(path,fixture?['--fixture']:[...args],{shell:false,stdio:['pipe','pipe','pipe']}),helper);
const sessions=new Map<string,Session>();let window:BrowserWindow;
function protectedWindow(win:BrowserWindow){win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());}
function check(event:Electron.IpcMainInvokeEvent){
  if(!ipcAllowed({senderId:event.sender.id,frameUrl:event.senderFrame?.url||'',isMainFrame:event.senderFrame===event.sender.mainFrame},window.webContents.id,localUrl))throw new Error('Access denied');
}
async function credential():Promise<Secret>{
  if(fixture)return {password:'',domain:''};
  return new Promise((resolve,reject)=>{
    const prompt=new BrowserWindow({width:410,height:330,parent:window,modal:true,resizable:false,title:'Kredensial RDP',webPreferences:{preload:join(root,'src/desktop/credential-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    let settled=false;protectedWindow(prompt);
    const submit=(event:Electron.IpcMainEvent,value:unknown)=>{
      if(event.sender.id!==prompt.webContents.id||event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==credentialUrl)return;
      if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;
      if(typeof v.password!=='string'||typeof v.domain!=='string'||v.password.length>4096||v.domain.length>256||v.password.includes('\0')||v.domain.includes('\0'))return;
      settled=true;resolve({password:v.password,domain:v.domain});prompt.close();
    };
    ipcMain.on('credential:submit',submit);prompt.on('closed',()=>{ipcMain.removeListener('credential:submit',submit);if(!settled)reject(new Error('Dibatalkan'));});void prompt.loadURL(credentialUrl);
  });
}
app.whenReady().then(async()=>{
  electronSession.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window=new BrowserWindow({width:1220,height:810,minWidth:850,minHeight:600,title:'Remote Workspace RDP',backgroundColor:'#edf1f5',webPreferences:{preload:join(root,'src/desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  protectedWindow(window);
  ipcMain.handle('rdp:info',event=>{check(event);return {fixture,platform:process.platform,arch:process.arch};});
  ipcMain.handle('rdp:open',async(event,value)=>{
    check(event);const target=validateTarget(value);const secret=await credential();const id=randomUUID();
    const s=await owner.open(target,secret,{
      frame:frame=>{if(!window.isDestroyed())window.webContents.send('rdp:frame',{id,...frame});},
      state:(state,reason)=>{if(!window.isDestroyed())window.webContents.send('rdp:state',{id,state,reason});}
    });sessions.set(id,s);return id;
  });
  ipcMain.handle('rdp:input',(event,id,value)=>{check(event);if(typeof id!=='string')throw new Error('Invalid session');sessions.get(id)?.send(validateInput(value));});
  ipcMain.handle('rdp:close',async(event,id)=>{check(event);if(typeof id!=='string')throw new Error('Invalid session');const s=sessions.get(id);await s?.close();sessions.delete(id);});
  window.on('closed',()=>{for(const s of sessions.values())void s.close();});
  await window.loadURL(localUrl);
});
app.on('window-all-closed',async()=>{await Promise.all([...sessions.values()].map(s=>s.close()));app.quit();});
