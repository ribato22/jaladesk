import {DocumentMaintenance} from './document-maintenance.js';
import {runtimePaths} from './runtime-paths.js';
import {OperationPlans} from './operation-plans.js';
import {TransferService} from './transfer-service.js';
import {BulkService} from './bulk-service.js';
import {BulkScheduler} from './bulk-scheduler.js';
import {ConnectFifo,StoredBeginAdapter} from './stored-begin.js';
import {DocumentWatcher} from '../documents/watch.js';
import {DocumentPropertiesService} from './document-properties-service.js';
import {app,BrowserWindow,clipboard,dialog,ipcMain,Menu,nativeImage,nativeTheme,safeStorage,session as electronSession} from 'electron';
import {initCertCache,warmRdpCert,prepareRdpTarget,splitDomainUser,probeProtocol,execProtocol,launchExternalProtocol,discoverSshEnvironment,upsertCustomJumpHost,removeCustomJumpHost,configureRdpGateway,startSshTunnel,stopSshTunnel,listSshTunnels,openPtySession,readPtySession,writePtySession,resizePtySession,closePtySession,openVncSession,readVncFrame,sendVncInput,closeVncSession,listKnownHostsAndCerts,removeKnownHostOrCertPin,sendWakeOnLan,runPortKnock,scanNetworkRange,readSshConfigFile,upsertSshConfigBlock,deleteSshConfigBlock,listLocalDirectory,localFileAction,remoteFileAction,listSshKeyPairs,generateSshKeyPair,deploySshPublicKey,auditTlsCertificateEndpoint,runNetworkPathAndDnsDiag,runHttpEndpointHealthProbe,runFleetTimeSyncAudit,manageSshCertificateAuthority,runPrometheusScrape,generateWireGuardPeerBundle,sendAlertRelayTest,runIpWhoisAndAsnLookup,runHttpLoadBenchmark,runTeamVaultGitSync} from './protocol-engine.js';
import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {mkdirSync} from 'node:fs';
import {makeOwner,ipcAllowed,type Session} from '../protocols/rdp/owner.js';
import {createProfiledOwner,closeProfiledSessions} from '../protocols/rdp/profiled-owner.js';
import {makeFrameDelivery} from '../protocols/rdp/delivery.js';
import {describeClipboard,makeClipboardGate} from '../protocols/rdp/clipboard.js';
import {validateTarget,validateInput,type RdpTarget,type Secret} from '../protocols/rdp/wire.js';
import {DocumentLibrary,checkName} from '../documents/library.js';
import {MAX_PASSWORD_BYTES} from '../documents/envelope.js';
import {decideClose,notSavedNotice,saveAllQuestion,type CloseDialogs} from './close-guard.js';
import {registerDocumentIpc,duplicateQuestion,upgradeQuestion,suggestedFileName,type Dialogs,type PasswordAnswer,type PasswordRequest,type PreferencesNotice} from './documents-ipc.js';
import {StoredConnections,registerStoredIpc} from './connections.js';
import {requestCredentialInput} from './credentials-ipc.js';
import {CredentialsService,editedCredential,type CredentialPrompt} from './credential-service.js';
import {TemplateService} from './template-service.js';
import {OverrideService} from './override-service.js';
import {registerWorkspaceIpc} from './workspace-ipc.js';
import {redactCredentialError} from '../credentials/model.js';
import {Preferences,PreferencesError,type AutosaveMode} from './preferences.js';
import {followLibrary} from './autosave.js';
import {registerSafetyIpc,reloadQuestion,restoreAllQuestion,type SafetyDialogs} from './safety-ipc.js';
import {timeLabel} from './history-view.js';
import {aboutNotice} from './about.js';
import {platformFrom} from './commands.js';
import {closesWindow} from './key-match.js';
import {Settings,SettingsError} from './settings.js';
import {createShell,type Shell} from './shell.js';
import type {TemplateItem} from './menu.js';

const EN_MENU_LABELS: Readonly<Record<string, string>> = {
  'Berkas': 'File',
  'Sunting': 'Edit',
  'Objek': 'Object',
  'Tampilan': 'View',
  'Jendela': 'Window',
  'Bantuan': 'Help',
  'Buka Terbaru': 'Open Recent',
  'Simpan Otomatis': 'Auto Save',
  'Tema': 'Theme',
  'Pilih Tab': 'Select Tab',
  'Urungkan': 'Undo',
  'Ulangi': 'Redo',
  'Potong': 'Cut',
  'Salin': 'Copy',
  'Tempel': 'Paste',
  'Pilih Semua': 'Select All',
  'Layanan': 'Services',
  'Sembunyikan yang Lain': 'Hide Others',
  'Tampilkan Semua': 'Show All',
  'Minimalkan': 'Minimize',
  'Perbesar': 'Zoom',
  'Bawa Semua ke Depan': 'Bring All to Front',
  'Sembunyikan Toolbar': 'Hide Toolbar',
  'Tampilkan Toolbar': 'Show Toolbar',
  'Masuk Layar Penuh': 'Enter Full Screen',
  'Keluar dari Layar Penuh': 'Exit Full Screen',
  'Keluar': 'Quit',
};

const EN_MENU_IDS: Readonly<Record<string, string>> = {
  'doc.new': 'New Document…',
  'doc.open': 'Open Document…',
  'doc.recent.clear': 'Clear Recent',
  'doc.vault': 'Vault & Credentials…',
  'doc.properties': 'Document Properties…',
  'doc.password': 'Change Document Password…',
  'doc.save': 'Save',
  'doc.autosave.off': 'Off',
  'doc.autosave.close': 'On Close',
  'doc.autosave.edit': 'On Edit',
  'doc.reload': 'Reload Document…',
  'doc.conflicts': 'Conflicts…',
  'doc.history': 'Revision History…',
  'doc.forgetKey': 'Forget Remembered Key',
  'doc.close': 'Close Document',
  'session.closeTab': 'Close Tab',
  'find': 'Search…',
  'obj.connect': 'Connect',
  'session.reconnect': 'Reconnect',
  'session.disconnect': 'Disconnect',
  'session.release': 'Release Keyboard from Session',
  'obj.addFolder': 'New Folder…',
  'obj.addConnection': 'New Connection…',
  'obj.templates': 'Templates…',
  'obj.edit': 'Properties…',
  'obj.duplicate': 'Duplicate',
  'obj.transfer': 'Copy / Move to Document…',
  'obj.bulk': 'Batch / Multi-Connect…',
  'obj.favorite': 'Favorite',
  'obj.remove': 'Delete',
  'tree.expandAll': 'Expand All Folders',
  'tree.collapseAll': 'Collapse All Folders',
  'adhoc.focus': 'Quick Connect',
  'view.customizeToolbar': 'Customize Toolbar…',
  'view.colorizeTabs': 'Colorize Tabs',
  'view.theme.system': 'System',
  'view.theme.light': 'Light',
  'view.theme.dark': 'Dark',
  'view.extendedFullscreen': 'Extended Full Screen',
  'tab.next': 'Next Tab',
  'tab.previous': 'Previous Tab',
  'tab.moveLeft': 'Move Tab Left',
  'tab.moveRight': 'Move Tab Right',
  'tab.last': 'Last Tab',
  'help.shortcuts': 'Keyboard Shortcuts…',
  'app.settings': 'Settings…',
};

function englishMenu(items: TemplateItem[]): TemplateItem[] {
  return items.map((item): TemplateItem => {
    let label = item.label;
    if (item.id && EN_MENU_IDS[item.id]) {
      label = EN_MENU_IDS[item.id];
    } else if (label && EN_MENU_LABELS[label]) {
      label = EN_MENU_LABELS[label];
    } else if (label?.startsWith('Tentang ')) {
      label = `About ${label.slice('Tentang '.length)}`;
    } else if (label?.startsWith('Sembunyikan ')) {
      label = `Hide ${label.slice('Sembunyikan '.length)}`;
    } else if (label?.startsWith('Keluar dari ')) {
      label = `Quit ${label.slice('Keluar dari '.length)}`;
    }
    return {
      ...item,
      ...(label !== undefined ? { label } : {}),
      ...(item.submenu ? { submenu: englishMenu(item.submenu) } : {}),
    };
  });
}
import {senderOf} from './sender.js';
import {registerShellIpc,type SettingsNotice} from './shell-ipc.js';
import {backgroundOf} from './theme.js';
import {electronSecretBox} from '../documents/safestorage.js';
import {Keystore} from './keystore.js';
import {Recent,recentLabels} from './recent.js';
import {registerSettingsIpc} from './settings-ipc.js';
import {registerViewIpc} from './view-ipc.js';
// RW_USER_DATA names another data folder: the GUI scripts run on one of their own, never on the folder that the owner's own runs use (the preferences in it are theirs, not a fixture's).
const root=app.getAppPath(),paths=runtimePaths({platform:process.platform,packaged:app.isPackaged,appRoot:root,appData:app.getPath('appData'),override:process.env.RW_USER_DATA}),scratch=paths.userData;
mkdirSync(scratch,{recursive:true});mkdirSync(paths.sessionData,{recursive:true});
app.setName('JalaDesk');app.setPath('userData',scratch);app.setPath('sessionData',paths.sessionData);
// One copy of the app per data folder (the lock is taken for the folder set just above): the favourites and the settings are files that two copies would write over each other. A second start asks the first to come forward and ends.
const single=app.requestSingleInstanceLock();if(!single)app.quit();
const fixture=process.argv.includes('--fixture');
const localUrl=pathToFileURL(join(root,'src/desktop/index.html')).href;
const credentialUrl=pathToFileURL(join(root,'src/desktop/credential.html')).href;
const credentialInputUrl=pathToFileURL(join(root,'src/desktop/credential-input.html')).href;
const passwordUrl=pathToFileURL(join(root,'src/desktop/password.html')).href;
const settingsUrl=pathToFileURL(join(root,'src/desktop/settings.html')).href;
const helper=join(root,'native/bin',process.platform==='win32'?'rdp-bridge.exe':'rdp-bridge');
const owner=fixture?makeOwner(path=>spawn(path,['--fixture'],{shell:false,stdio:['pipe','pipe','pipe']}),helper):createProfiledOwner({root:scratch,helper});
const sessions=new Map<string,Session>();let window:BrowserWindow;let shell:Shell|undefined;
const reportProfileCleanup=(message:string)=>console.error('[rdp]',message);
const connectQueue=new ConnectFifo();
const connectLifetime=new AbortController();
const deliveries=new Map<string,ReturnType<typeof makeFrameDelivery>>();
const gate=makeClipboardGate(clipboard,()=>!!window&&!window.isDestroyed()&&window.isFocused());
function protectedWindow(win:BrowserWindow){win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());}
// A window of the main process that asks for something (a password, a credential): it has no menu of its own to use, the menu of the application is off while it is open, and it opens in the colours of the theme.
// On Windows and Linux Menu.setApplicationMenu sets the menu on EVERY window, the ones that are open included, so the menu of an open window like this is taken off again after each time the menu is put in place.
const prompts=new Set<BrowserWindow>();
// The window of the settings is not a prompt (the application goes on being used beside it), but it has no menu of its own either.
const plains=new Set<BrowserWindow>();
const withoutMenus=()=>{if(process.platform!=='darwin')for(const win of [...prompts,...plains])if(!win.isDestroyed())win.removeMenu();};
function asking(prompt:BrowserWindow,signal?:AbortSignal){
  protectedWindow(prompt);prompts.add(prompt);withoutMenus();shell?.setPrompt(true);
  // a box in it (the password) has the editing menu too: Paste with the mouse
  prompt.webContents.on('context-menu',(_event,params)=>{shell?.editContext({isEditable:params.isEditable,selectionText:params.selectionText,editFlags:params.editFlags},prompt);});
  const abort=()=>{if(!prompt.isDestroyed())prompt.close();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)queueMicrotask(abort);
  prompt.once('closed',()=>{signal?.removeEventListener('abort',abort);prompts.delete(prompt);shell?.setPrompt(false);});
}
// A dialog of the main process (a question, the file dialogs, About) holds the window, and the menu is off while one is open: a sheet stops the buttons of the page but not the items of the menu.
const modal=async<T>(run:()=>Promise<T>)=>{shell?.setPrompt(true);try{return await run();}finally{shell?.setPrompt(false);}};
const native={showMessageBox:(w:BrowserWindow,o:Electron.MessageBoxOptions)=>modal(()=>dialog.showMessageBox(w,o)),showOpenDialog:(w:BrowserWindow,o:Electron.OpenDialogOptions)=>modal(()=>dialog.showOpenDialog(w,o)),showSaveDialog:(w:BrowserWindow,o:Electron.SaveDialogOptions)=>modal(()=>dialog.showSaveDialog(w,o))};
function check(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent){
  if(!ipcAllowed(senderOf(event),window.webContents.id,localUrl))throw new Error('Access denied');
}
// The window of the settings is a window of its own with channels of its own: only it, at its own page, may use them.
let settingsWindow:BrowserWindow|undefined;
function settingsCheck(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent){
  const win=settingsWindow;
  if(!win||win.isDestroyed()||!ipcAllowed(senderOf(event),win.webContents.id,settingsUrl))throw new Error('Access denied');
}
function openSettings(){
  if(settingsWindow&&!settingsWindow.isDestroyed()){if(settingsWindow.isMinimized())settingsWindow.restore();settingsWindow.show();settingsWindow.focus();return;}
  const win=new BrowserWindow({width:780,height:620,minWidth:640,minHeight:480,useContentSize:true,title:'JalaDesk Settings & Preferences',backgroundColor:backgroundOf('aside',nativeTheme.shouldUseDarkColors),maximizable:true,fullscreenable:false,webPreferences:{preload:join(root,'src/desktop/settings-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  settingsWindow=win;protectedWindow(win);plains.add(win);withoutMenus();
  // The menu of the Mac is one for all the windows: while this window has the focus the commands of the main window are off (Cmd+W would close a tab there), and this window closes itself on that key.
  win.on('focus',()=>shell?.setAway(true));win.on('blur',()=>shell?.setAway(false));
  win.webContents.on('before-input-event',(event,input)=>{if(closesWindow(platformFrom(process.platform),input)){event.preventDefault();win.close();}});
  win.on('closed',()=>{plains.delete(win);if(settingsWindow===win)settingsWindow=undefined;shell?.setAway(false);});
  void win.loadURL(settingsUrl);
}
async function credential(target:RdpTarget):Promise<Secret>{
  if(fixture)return {password:'',domain:''};
  warmRdpCert(target,fixture);
  const split=splitDomainUser(target.username);
  return new Promise((resolve,reject)=>{
    // 410x400 is the size of the form itself (it needs 355, the rest is spare for other platforms' fonts): useContentSize keeps the title bar and, on Windows, the menu bar out of that height.
    const prompt=new BrowserWindow({width:410,height:400,useContentSize:true,autoHideMenuBar:true,backgroundColor:backgroundOf('aside',nativeTheme.shouldUseDarkColors),parent:window,modal:true,resizable:false,title:'RDP Credentials',webPreferences:{preload:join(root,'src/desktop/credential-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    let settled=false;asking(prompt,connectQueue.activeSignal);
    prompt.webContents.once('did-finish-load',()=>prompt.webContents.send('credential:target',{label:`${split.username}@${target.host}:${target.port}${split.domain?` (Domain: ${split.domain})`:''}`,clipboard:describeClipboard(target.clipboard)}));
    const submit=(event:Electron.IpcMainEvent,value:unknown)=>{
      if(event.sender.id!==prompt.webContents.id||event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==credentialUrl)return;
      if(!value||typeof value!=='object')return;const v=value as Record<string,unknown>;
      if(typeof v.password!=='string'||typeof v.domain!=='string'||v.password.length>4096||v.domain.length>256||v.password.includes('\0')||v.domain.includes('\0'))return;
      settled=true;resolve({password:v.password,domain:v.domain.trim()||split.domain});prompt.close();
    };
    ipcMain.on('credential:submit',submit);prompt.on('closed',()=>{ipcMain.removeListener('credential:submit',submit);if(!settled)reject(new Error('Cancelled'));});void prompt.loadURL(credentialUrl);
  });
}
// Documents: the library of open documents and the dialogs it needs. The renderer never names a path and never sees a password.
const library=new DocumentLibrary({report:error=>console.error('[documents]',redactCredentialError(error))});
let privateOverlays:OverrideService|undefined;
const privateStamp=()=>JSON.stringify([library.privateDocuments().map(s=>[s.handle,s.generation]),privateOverlays?.state().generation]);
let privateInputBusy=false;
async function isolatedCredentialInput(options:Parameters<typeof requestCredentialInput>[0],currentGeneration:()=>number,signal?:AbortSignal){
  if(signal?.aborted)return undefined;
  if(privateInputBusy||prompts.size)throw Object.assign(new Error('Dialog masih terbuka'),{code:'busy'});
  privateInputBusy=true;let closed:Promise<void>=Promise.resolve();
  try{
    const answer=await requestCredentialInput(options,{
      open(request,submit,cancel){
        const prompt=new BrowserWindow({width:510,height:860,useContentSize:true,autoHideMenuBar:true,parent:window,modal:true,resizable:true,title:request.purpose==='protected'?'Nilai terlindungi':'Kredensial',webPreferences:{preload:join(root,'src/desktop/credential-input-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
        closed=new Promise<void>(done=>prompt.once('closed',done));asking(prompt,signal);
        const eventOf=(event:Electron.IpcMainEvent)=>{const source=senderOf(event);return{senderId:source.senderId,origin:source.frameUrl,mainFrame:event.senderFrame};};
        const submitted=(event:Electron.IpcMainEvent,payload:unknown)=>submit(eventOf(event),payload,currentGeneration());
        const cancelled=(event:Electron.IpcMainEvent,payload:unknown)=>cancel(eventOf(event),payload);
        ipcMain.on('credential-input:submit',submitted);ipcMain.on('credential-input:cancel',cancelled);
        const unsubscribe=library.onChange(()=>{if(currentGeneration()!==request.generation)cancel();});
        prompt.webContents.once('did-finish-load',()=>prompt.webContents.send('credential-input:request',request));
        prompt.webContents.once('did-fail-load',()=>cancel());
        prompt.once('closed',()=>{unsubscribe();ipcMain.removeListener('credential-input:submit',submitted);ipcMain.removeListener('credential-input:cancel',cancelled);cancel();});
        void prompt.loadURL(credentialInputUrl).catch(()=>cancel());
        return{senderId:prompt.webContents.id,origin:credentialInputUrl,get mainFrame(){return prompt.webContents.mainFrame;},clear(){if(!prompt.isDestroyed())prompt.webContents.send('credential-input:clear');},close(){if(!prompt.isDestroyed())prompt.close();}};
      },
    });
    await closed;return answer;
  }finally{privateInputBusy=false;}
}
async function credentialEditor(request:CredentialPrompt){
  const stamp=privateStamp();return isolatedCredentialInput({binding:{promptId:randomUUID(),generation:request.generation},label:request.label.slice(0,512),purpose:request.purpose,initial:{username:request.username??'',domain:request.domain??'',hasPassword:request.hasPassword??false,hasTotp:request.hasTotp??false}},()=>privateStamp()===stamp?request.generation:-1);
}
async function storedCredential(target:RdpTarget,context:{id:string;generation:number;currentGeneration():number},label?:string){
  if(fixture)return{username:target.username,domain:'',password:''};
  const answer=await isolatedCredentialInput({binding:{promptId:context.id,generation:context.generation},label:(label??`${target.host}:${target.port} — ${target.username}`).slice(0,512),purpose:'create'},context.currentGeneration,connectQueue.activeSignal);
  return answer?{username:answer.username,domain:answer.domain,password:answer.passwordAction==='replace'?answer.password??'':''}:undefined;
}

const MIN_NEW_PASSWORD=8;
function askPassword(request:PasswordRequest):Promise<PasswordAnswer|undefined>{
  return new Promise(resolve=>{
    const prompt=new BrowserWindow({width:410,height:(request.purpose==='create'?400:300)+(request.rememberable?96:0),useContentSize:true,autoHideMenuBar:true,backgroundColor:backgroundOf('aside',nativeTheme.shouldUseDarkColors),parent:window,modal:true,resizable:false,title:request.purpose==='create'?'Password dokumen baru':'Buka dokumen',webPreferences:{preload:join(root,'src/desktop/password-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    let settled=false;asking(prompt);
    prompt.webContents.once('did-finish-load',()=>prompt.webContents.send('password:request',{...request,minLength:request.purpose==='create'?MIN_NEW_PASSWORD:1,maxBytes:MAX_PASSWORD_BYTES}));
    const own=(event:Electron.IpcMainEvent)=>ipcAllowed(senderOf(event),prompt.webContents.id,passwordUrl);
    const submit=(event:Electron.IpcMainEvent,value:unknown)=>{
      if(!own(event)||!value||typeof value!=='object')return;const v=value as Record<string,unknown>;
      if(typeof v.password!=='string'||Buffer.byteLength(v.password.normalize('NFC'))>MAX_PASSWORD_BYTES||v.password.length<(request.purpose==='create'?MIN_NEW_PASSWORD:1))return;
      if(request.purpose==='create'&&v.confirm!==v.password)return;
      settled=true;resolve(request.rememberable?{password:v.password,remember:v.remember===true}:v.password);prompt.close();
    };
    const cancel=(event:Electron.IpcMainEvent)=>{if(own(event))prompt.close();};
    ipcMain.on('password:submit',submit);ipcMain.on('password:cancel',cancel);
    prompt.on('closed',()=>{ipcMain.removeListener('password:submit',submit);ipcMain.removeListener('password:cancel',cancel);if(!settled)resolve(undefined);});
    void prompt.loadURL(passwordUrl);
  });
}
const documentFilters=[{name:'Remote Workspace Document',extensions:['rwdoc']}];
const dialogs:Dialogs={
  async chooseOpenPath(){const r=await native.showOpenDialog(window,{title:'Open Document',filters:documentFilters,properties:['openFile']});return r.canceled?undefined:r.filePaths[0];},
  async chooseSavePath(suggested){const r=await native.showSaveDialog(window,{title:'Save New Document',defaultPath:suggested,filters:documentFilters,properties:['createDirectory']});return r.canceled?undefined:r.filePath;},
  askPassword,
  async confirmDuplicate(name){return(['skip','cancel','copy'] as const)[(await native.showMessageBox(window,duplicateQuestion(name))).response]??'cancel';},
  async confirmUpgrade(name){return(await native.showMessageBox(window,upgradeQuestion(name))).response===1;},
  async confirmClose(name,why){const r=await native.showMessageBox(window,{type:'question',buttons:['Save','Don’t Save','Cancel'],defaultId:0,cancelId:2,message:`Save changes to “${name}”?`,detail:why?`${why}\n\nUnsaved changes will be lost.`:'Unsaved changes will be lost.'});return (['save','discard','cancel'] as const)[r.response]??'cancel';},
  async confirmRemove(name,count){const r=await native.showMessageBox(window,{type:'warning',buttons:['Delete','Cancel'],defaultId:1,cancelId:1,message:count>1?`Delete “${name}” and ${count-1} objects inside?`:`Delete “${name}”?`,detail:'Open session tabs are unaffected. Deletion is written to disk when you save the document.'});return r.response===0;},
};
// What throws work away is asked in a dialog of the main process: reloading a document from its file, and putting a whole earlier version in.
const safetyDialogs:SafetyDialogs={
  async confirmReload(name){return (await native.showMessageBox(window,reloadQuestion(name))).response===0;},
  async confirmRestoreAll(name,at,unsaved){return (await native.showMessageBox(window,restoreAllQuestion(name,timeLabel(at),unsaved))).response===0;},
};
let autosaveOf:((docId:string)=>AutosaveMode|undefined)|undefined;   // set when the preferences are open: a document that saves by itself is not asked about when it is closed
let closing=false,deciding=false;
// Closing the window with unsaved documents asks once for all of them; close-guard.ts decides, so nothing is lost without a yes.
const closeDialogs=(win:BrowserWindow):CloseDialogs=>({
  async askSaveAll(names){const r=await native.showMessageBox(win,saveAllQuestion(names));return (['save','discard','cancel'] as const)[r.response]??'cancel';},
  async tellNotSaved(reason,documents){await native.showMessageBox(win,notSavedNotice(reason,documents));},
});
// A close that does not finish (a document that cannot be saved keeps the window) may have saved documents or taken another program's changes into them: the window is told, and takes them again.
const seqsOfDocuments=()=>library.views().map(v=>`${v.id}:${v.seq}`).join();
function guardUnsaved(win:BrowserWindow){
  win.on('close',event=>{
    if(closing||(library.dirtyIds().length===0&&!privateOverlays?.state().dirty))return;event.preventDefault();
    if(deciding)return;deciding=true; // a second close while the question is open is the same question
    const before=seqsOfDocuments();
    void (async()=>{if(privateOverlays&&!await privateOverlays.closeForWindow())return 'cancel' as const;return decideClose(library,closeDialogs(win),id=>{try{return autosaveOf?.(library.view(id).docId)!==undefined;}catch{return false;}});})().then(decision=>{if(decision==='close'){closing=true;win.close();}else if(seqsOfDocuments()!==before&&!win.isDestroyed())win.webContents.send('documents:refresh');})
      .catch(error=>{console.error('[documents]',error);dialog.showErrorBox('Jendela tidak ditutup','Perubahan yang belum disimpan tidak dapat diperiksa karena terjadi kesalahan.');})
      .finally(()=>{deciding=false;});
  });
}
app.whenReady().then(async()=>{
  if(!single)return;
  app.on('second-instance',()=>{const w=window&&!window.isDestroyed()?window:undefined;if(!w)return;if(w.isMinimized())w.restore();w.show();w.focus();});
  electronSession.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  // What the person chose for the application on this computer (the theme, the toolbar): a file of its own, apart from the favourites. If it cannot be understood it is set aside and the defaults are used; if it
  // cannot be used at all the choices are held in memory until the app is closed. Either way the window is told once. The theme is made known BEFORE the window exists, so that it opens in the colours it will have.
  let settingsNotice:SettingsNotice|undefined;
  const settings=await Settings.open(join(app.getPath('userData'),'settings.json')).then(opened=>{if(opened.setAside)settingsNotice='reset';return opened;},error=>{console.error('[settings]',error);settingsNotice=error instanceof SettingsError&&error.code==='too-new'?'too-new':'unavailable';return Settings.memory();});
  nativeTheme.themeSource=settings.values().theme;
  // The recent documents, and the keys that the system remembers: both in files of their own in the data folder. The keystore of the system is not asked anything until the person allows keys (keystore.ts).
  const recent=await Recent.open(join(app.getPath('userData'),'recent.json'));
  const keystore=new Keystore({box:electronSecretBox(safeStorage),dir:join(app.getPath('userData'),'keys'),allowed:()=>settings.values().keys.allow});
  await keystore.refresh();   // how many keys are remembered: counted from the files of the folder, which asks the keystore of the system nothing
  await initCertCache(app.getPath('userData'));
  const appIcon=nativeImage.createFromPath(join(root,'src/desktop/app-icon.png'));
  if(process.platform==='darwin'&&!appIcon.isEmpty())app.dock?.setIcon(appIcon);
  window=new BrowserWindow({width:1220,height:810,minWidth:850,minHeight:600,title:'JalaDesk',...(appIcon.isEmpty()?{}:{icon:appIcon}),backgroundColor:backgroundOf('page',nativeTheme.shouldUseDarkColors),webPreferences:{preload:join(root,'src/desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  protectedWindow(window);guardUnsaved(window);
  // What the person chose for themselves on this computer (their favourites) is kept in a file of its own in the application's data folder, not in any document. If that file cannot be
  // understood it is set aside and the favourites start empty, and if it cannot be opened at all they are off: the window is told either way, once, and everything else goes on.
  let notice:PreferencesNotice|undefined;
  const preferences=await Preferences.open(join(app.getPath('userData'),'preferences.json')).then(opened=>{if(opened.setAside)notice='reset';return opened;},error=>{console.error('[preferences]',error);notice=error instanceof PreferencesError&&error.code==='too-new'?'too-new':'unavailable';return undefined;});
  if(preferences)autosaveOf=docId=>preferences.autosaveOf(docId);
  // Documents that were chosen to save by themselves are saved by a timer, and the windows are sent what that left (a change) or could not do (a failure, or a save held back by a conflict).
  const followed=followLibrary({library,...(preferences?{preferences}:{}),push:(channel,payload)=>{if(!window.isDestroyed())window.webContents.send(channel,payload);},report:error=>console.error('[documents]',error)});
  registerDocumentIpc({ipc:ipcMain,check,library,dialogs,keys:keystore,recent,...(preferences?{preferences}:{}),...(notice?{notice}:{}),...(autosaveOf?{autosaveOf}:{}),report:error=>console.error('[documents]',error)});
  registerSafetyIpc({ipc:ipcMain,check,library,dialogs:safetyDialogs,...(preferences?{preferences}:{}),autosaver:followed.autosaver,report:error=>console.error('[documents]',error)});
  // The menu, the toolbar's choices and the theme: the shell keeps the menu in step with what the window reports (shell.ts) and does the commands that are the main process's own.
  const platform=platformFrom(process.platform);
  const live=()=>window&&!window.isDestroyed()?window:undefined;
  shell=createShell({platform,appName:app.getName(),settings,setApplicationMenu:template=>{Menu.setApplicationMenu(Menu.buildFromTemplate(englishMenu(template) as Electron.MenuItemConstructorOptions[]));withoutMenus();},defer:run=>{setImmediate(run);},
    fallbackMenu:()=>{Menu.setApplicationMenu(platform==='darwin'?Menu.buildFromTemplate([{role:'appMenu'}]):null);withoutMenus();},   // when no menu of ours can be put in place: not the default menu of Electron, with Reload and the tools of the developer
    window:()=>{const w=live();return w?{send:(channel,payload)=>w.webContents.send(channel,payload),isFullScreen:()=>w.isFullScreen(),setFullScreen:on=>w.setFullScreen(on),setBackgroundColor:color=>w.setBackgroundColor(color)}:undefined;},
    nativeTheme:{setSource:choice=>{nativeTheme.themeSource=choice;},isDark:()=>nativeTheme.shouldUseDarkColors},
    showAbout:()=>{const n=aboutNotice({name:app.getName(),version:app.getVersion(),electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,platform:process.platform,arch:process.arch});void native.showMessageBox(window,{...n,message:n.message.replace(/^Tentang /,'About '),detail:n.detail.replace(/^Versi /,'Version '),buttons:['Close']}).catch(error=>console.error('[shell]',error));},
    recent:{labels:()=>recentLabels(recent.list()),clear:()=>recent.clear(),subscribe:listener=>recent.subscribe(()=>listener()),choose:place=>recent.choose(place)},keys:{known:()=>keystore.known(),subscribe:listener=>keystore.subscribe(listener)},openSettings,
    popup:(template,at,target)=>{Menu.buildFromTemplate(englishMenu(template) as Electron.MenuItemConstructorOptions[]).popup({window:target instanceof BrowserWindow&&!target.isDestroyed()?target:window,...(at?{x:at.x,y:at.y}:{})});},
    quit:()=>app.quit(),report:error=>console.error('[shell]',error)});
  registerShellIpc({ipc:ipcMain,check,shell,settings,notice:()=>{const told=settingsNotice;settingsNotice=undefined;return told;},report:error=>console.error('[shell]',error)});
  registerViewIpc({ipc:ipcMain,check,shell,report:error=>console.error('[shell]',error)});
  // The window of the settings: its own channels, and what it shows is sent again whenever the settings or the list of recent documents change (the keys that are remembered are asked for when the window gets the focus).
  const settingsApi=registerSettingsIpc({ipc:ipcMain,check:settingsCheck,settings,keystore,recent,
    confirmForget:async count=>(await native.showMessageBox(settingsWindow&&!settingsWindow.isDestroyed()?settingsWindow:window,{type:'warning',buttons:['Lupakan semua','Batal'],defaultId:1,cancelId:1,message:count>1?`Lupakan ${count} kunci yang diingat?`:'Lupakan kunci yang diingat?',detail:'Dokumen itu akan meminta sandinya lagi saat dibuka berikutnya.'})).response===0,
    report:error=>console.error('[settings]',error)});
  const pushSettings=()=>{if(settingsWindow&&!settingsWindow.isDestroyed())void settingsApi.view().then(view=>{if(settingsWindow&&!settingsWindow.isDestroyed())settingsWindow.webContents.send('settings:changed',view);}).catch(()=>{});};
  settings.subscribe(pushSettings);recent.subscribe(pushSettings);
  window.on('enter-full-screen',()=>{shell?.fullScreenChanged(true);if(!window.isDestroyed())window.webContents.send('shell:view-changed',{colorTabs:settings.values().tabs.colorize,extended:true});});window.on('leave-full-screen',()=>{shell?.fullScreenChanged(false);if(!window.isDestroyed())window.webContents.send('shell:view-changed',{colorTabs:settings.values().tabs.colorize,extended:false});});nativeTheme.on('updated',()=>shell?.themeChanged());
  // The page is offered a key before the menu, and the screen of a connected session consumes every key: the few keys that stay the application's while a session holds the keyboard are taken here, before the page.
  window.webContents.on('before-input-event',(event,input)=>{if(shell?.keyDown(input))event.preventDefault();});
  // A page that is gone can do nothing: the menu says so, instead of what the page said last (a click on an item would go to a page that is not there). There is no Reload to bring it back: the window is closed and the app started again.
  window.webContents.on('render-process-gone',()=>{shell?.pageGone();});
  // A box that can be typed in has no menu of its own in Electron: the editing menu is shown here (the remote screens and the tree ask for theirs with shell:context; they stop this one by stopping the event of the page).
  window.webContents.on('context-menu',(_event,params)=>{shell?.editContext({isEditable:params.isEditable,selectionText:params.selectionText,editFlags:params.editFlags});});
  ipcMain.handle('rdp:info',event=>{check(event);return {fixture,platform:process.platform,arch:process.arch};});
  let begin:StoredBeginAdapter|undefined;
  const starting=new Map<string,Promise<Session|undefined>>();
  const closeEngine=async(id:string)=>{const session=sessions.get(id)??await starting.get(id);try{await session?.close();}finally{deliveries.get(id)?.close();deliveries.delete(id);gate.forget(id);sessions.delete(id);}};
  const openEngine=async(target:RdpTarget,secret:Secret)=>{
    if(connectQueue.activeSignal?.aborted||connectLifetime.signal.aborted)throw Object.assign(new Error('Connection cancelled'),{code:'cancelled'});
    const prepared=await prepareRdpTarget(target,secret,fixture);
    const id=randomUUID();
    const delivery=makeFrameDelivery((frame,sequence)=>{if(!window.isDestroyed())window.webContents.send('rdp:frame',{id,sequence,...frame});});deliveries.set(id,delivery);
    let s:Session|undefined,ready!:(session:Session|undefined)=>void;starting.set(id,new Promise(resolve=>{ready=resolve;}));
    let observer:ReturnType<StoredBeginAdapter['beforeSpawn']>|undefined;
    try{
      observer=begin?.beforeSpawn(id);
      const signal=connectQueue.activeSignal?AbortSignal.any([connectQueue.activeSignal,connectLifetime.signal]):connectLifetime.signal;
      s=await owner.open(prepared.target,prepared.secret,{
        frame:frame=>delivery.push(frame),
        clipboard:text=>{gate.remote(id,text).catch(()=>{});},
        state:(state,reason,lastError)=>{observer?.state(state);if(state==='closed'||state==='failed'){delivery.close();deliveries.delete(id);gate.forget(id);}if(!window.isDestroyed())window.webContents.send('rdp:state',{id,state,reason,...((state==='failed'||state==='closed')&&lastError!==undefined?{lastError}:{})});}
      },{signal});
      sessions.set(id,s);return id;
    }catch(error){observer?.failed(error);delivery.close();deliveries.delete(id);throw error;}
    finally{ready(s);starting.delete(id);}
  };
  const question=async(message:string,detail:string)=> (await native.showMessageBox(window,{type:'question',buttons:['Cancel','Continue'],defaultId:0,cancelId:0,message,detail})).response===1;
  privateOverlays=await OverrideService.load(library,{path:join(app.getPath('userData'),'private-overrides.rwdoc'),
    askPassword:async purpose=>{const answer=await askPassword({purpose:purpose==='create'?'create':'open',name:'Override privat'});return typeof answer==='string'?answer:answer?.password;},
    prompt:async request=>{const previous=request.previous?.kind==='credential'?request.previous:undefined;const answer=await credentialEditor({purpose:request.group==='credentials'?(previous?'edit':'inline'):'protected',label:`Override privat · ${request.group}`,generation:privateOverlays!.state().generation,username:previous?.username,domain:previous?.domain,hasPassword:previous?.password!==undefined,hasTotp:previous?.totp!==undefined});if(!answer)return undefined;if(request.group==='credentials')return editedCredential(answer,previous);return answer.protectedAction==='remove'?false:answer.protectedAction==='replace'?{kind:'protected-value' as const,value:answer.protectedValue!}:undefined;},
    confirmDirty:async()=>{const r=await native.showMessageBox(window,{type:'warning',buttons:['Simpan','Buang perubahan','Batal'],defaultId:2,cancelId:2,message:'Override privat belum disimpan',detail:'Simpan sebelum dikunci atau keluar; Buang perubahan hanya dipakai bila Anda memilihnya.'});return (['save','discard','cancel'] as const)[r.response]??'cancel';},
    confirmDisable:()=>question('Nonaktifkan pemakaian override privat?','Nilai bersama akan berlaku kembali. Berkas privat tetap disimpan.'),
  });
  const overlayLayers=(ref:{documentHandle:string;objectId:string;expectedSeq?:number})=>privateOverlays!.layers({id:ref.documentHandle,objectId:ref.objectId,...(ref.expectedSeq===undefined?{}:{expectedSeq:ref.expectedSeq})});
  const maintenance=new DocumentMaintenance(library,{watcher:new DocumentWatcher(),askPassword:async(purpose,name)=>{const answer=await askPassword({purpose:purpose==='old'?'open':'create',name:`${name} · ${purpose==='old'?'Password lama':'Password baru (revisi lama tetap memakai password lama)'}`});return typeof answer==='string'?answer:answer?.password;},forget:async path=>{await keystore.forget(path);},refresh:()=>{if(!window.isDestroyed())window.webContents.send('documents:refresh');}});
  const documentProperties=new DocumentPropertiesService(library,{prompt:credentialEditor,confirmShared:name=>question(`Simpan default privat pada workspace “${name}”?`,'Nilai privat ikut berkas ketika dibagikan. Gunakan referensi vault bila tidak ingin menyimpan secret dalam dokumen ini.')});
  const operationOwner=`workspace:${window.webContents.id}`;
  const plans=new OperationPlans(library,{scopeStamp:excluded=>JSON.stringify([privateOverlays!.state().generation,library.views().filter(view=>!excluded.includes(view.id)).map(view=>library.entryStamp(view.id))])});
  const transfer=new TransferService(library,plans,{
    confirmPrivate:m=>question('Salin data privat ke dokumen tujuan?',`${m.count} objek dari “${m.sourceName}” ke “${m.destinationName}”. Secret terenkripsi serta data privat/opaque ikut berkas tujuan. Override privat tidak disalin.`),
    confirmMove:m=>question('Hapus objek sumber setelah salinan terverifikasi?',`Tujuan “${m.destinationName}” sudah disimpan dan diverifikasi. Hapus ${m.count} objek dari “${m.sourceName}”? ${m.sourceReferencesAffected} referensi pada objek/default sumber yang tidak dipilih dapat terpengaruh; referensi tersebut tidak ditulis ulang. Batal mempertahankan kedua salinan.`),
  });
  const credentialsService=new CredentialsService(library,{prompt:credentialEditor,layers:overlayLayers,
    confirmShared:name=>question(`Simpan secret pada workspace “${name}”?`,'Secret ikut terbawa ketika berkas dibagikan. Gunakan vault privat untuk identitas baru kecuali Anda sengaja memilih workspace ini.'),
    confirmRemove:name=>question(`Hapus kredensial “${name}”?`,'Referensi yang memakai identitas ini akan gagal sampai diperbaiki. Penghapusan baru tersimpan saat dokumen disimpan.'),
    confirmCopy:name=>question(`Salin kode TOTP “${name}”?`,'Kode masuk clipboard sistem selama paling lama 30 detik. Isi tidak dikirim ke jendela utama.'),clipboard,
  });
  const stored=new StoredConnections({library,open:openEngine,prompt:storedCredential,layers:overlayLayers,privateSources:()=>privateOverlays!.privateSources(),
    approveScope:async request=>(await native.showMessageBox(window,{type:'question',buttons:['Batal','Izinkan sumber'],defaultId:0,cancelId:0,signal:connectQueue.activeSignal,message:`Izinkan kredensial untuk “${request.connection}”?`,detail:`Target: ${request.target.host}:${request.target.port}\nSertifikat: ${request.target.certificateSha256||'Validasi CA sistem'}\nClipboard lokal ke remote: ${request.target.clipboard?.toRemote?'ya':'tidak'}\n\nSumber:\n${request.sources.map(s=>s.name).join('\n')}\n\nIzin terikat pada target, koneksi dan sumber yang sedang terbuka.`})).response===1,
    promptCode:async()=>{const answer=await storedCredential({host:'mfa.invalid',port:3389,username:'MFA'},{id:randomUUID(),generation:0,currentGeneration:()=>0},'Masukkan kode MFA (6 atau 8 digit) pada kolom Password.');return answer?.password;},
  });
  registerStoredIpc({ipc:ipcMain,check,service:{openStored:value=>connectQueue.run(()=>stored.openStored(value),connectLifetime.signal),reconnectStored:id=>connectQueue.run(()=>stored.reconnectStored(id),connectLifetime.signal),forget:id=>stored.forget(id)}});
  begin=new StoredBeginAdapter({queue:connectQueue,openStored:async ref=>{const opened=await stored.openStored(ref);if(!window.isDestroyed())window.webContents.send('rdp:bulk-opened',opened);return opened;},close:closeEngine});
  const connects=new BulkScheduler({library,beginStored:(ref,signal)=>begin!.beginStored(ref,signal)});
  const templatesService=new TemplateService(library,{layers:overlayLayers,confirmPrivateValues:request=>question('Salin nilai privat ke template bersama?',`${request.count} objek memakai nilai efektif dari override privat. Nilai publik tersebut akan ikut berkas template bersama. Password, seed, key dan nilai terlindungi tetap tidak disalin.`),openAdHoc:node=>connectQueue.run(()=>stored.openTemporary(node),connectLifetime.signal),confirmReferences:request=>question('Salin referensi kredensial ke template?',`Sumber yang diminta: ${request.sourceDocumentIds.map(id=>library.privateDocuments().find(d=>d.doc.id===id)?.doc.name??id).join(', ')}. Secret tidak disalin; koneksi tetap meminta izin pemakaian sumber.`)});
  const bulk=new BulkService(library,plans,{prepareTemplate:ref=>templatesService.prepareBulk(ref),confirmReferences:m=>question('Salin referensi kredensial pada batch ini?',`${m.documents.map(document=>`${document.name}: ${document.count} koneksi`).join('\n')}\nSecret tidak disalin. Penggunaan identitas pada target baru tetap memerlukan persetujuan sumber saat menghubungkan.`)});
  const targetInput=(p:Record<string,unknown>)=>{if(typeof p.id!=='string'||!Number.isSafeInteger(p.expectedSeq))throw Object.assign(new Error(),{code:'invalid'});const state=library.privateDocument(p.id);if(state.seq!==p.expectedSeq)throw Object.assign(new Error(),{code:'stale'});return state;};
  const credentialKeys=['id','expectedSeq','objectId','expectedCredentialVersion'];
  registerWorkspaceIpc({ipc:ipcMain,check,refresh:()=>{if(!window.isDestroyed())window.webContents.send('documents:refresh');},actions:{
    'bulk.sources':{keys:[],run:()=>transfer.sources()},
    'bulk.preview':{keys:['documents','save'],run:p=>bulk.preview(operationOwner,p)},
    'bulk.apply':{keys:['planId'],changes:true,run:p=>bulk.apply(operationOwner,p)},
    'bulk.progress':{keys:['jobId'],run:p=>bulk.progress(operationOwner,p)},
    'bulk.cancel':{keys:['jobId'],run:p=>bulk.cancel(operationOwner,p)},
    'connects.start':{keys:['targets'],run:p=>connects.start(operationOwner,p)},
    'connects.progress':{keys:['jobId'],run:p=>connects.progress(operationOwner,p)},
    'connects.cancel':{keys:['jobId'],run:p=>connects.cancel(operationOwner,p)},
    'connects.retry':{keys:['jobId'],run:p=>connects.retry(operationOwner,p)},
    'connects.disconnect':{keys:['jobId','targets'],run:p=>connects.disconnect(operationOwner,p)},
    'transfer.sources':{keys:[],run:()=>transfer.sources()},
    'transfer.preview':{keys:['sourceId','sourceSeq','destinationId','destinationSeq','objectIds','parentId','mode','copyPrivate'],run:p=>transfer.preview(operationOwner,p)},
    'transfer.apply':{keys:['planId'],changes:true,run:p=>transfer.apply(operationOwner,p)},
    'transfer.cancel':{keys:['planId'],run:p=>transfer.cancel(operationOwner,p)},
    'maintenance.view':{keys:['id'],run:p=>{if(typeof p.id!=='string')throw Object.assign(new Error(),{code:'invalid'});return maintenance.view(p.id);}},
    'maintenance.notices':{keys:[],run:()=>maintenance.listNotices()},
    'maintenance.password':{keys:['id','expectedSeq','expectedMaintenanceVersion'],changes:true,run:p=>maintenance.changePassword(p)},
    'properties.view':{keys:['id'],run:p=>{if(typeof p.id!=='string')throw Object.assign(new Error(),{code:'invalid'});return documentProperties.view(p.id);}},
    'properties.apply':{keys:['id','expectedSeq','expectedPropertiesVersion','patch'],changes:true,run:p=>documentProperties.apply(p)},
    'properties.default':{keys:['id','expectedSeq','expectedPropertiesVersion','group','value','unset'],changes:true,run:p=>documentProperties.setDefaultGroup(p)},
    'credentials.list':{keys:[],run:()=>credentialsService.list()},
    'credentials.createVault':{keys:['name'],changes:true,run:async p=>{const name=checkName(p.name as string);const chosen=await dialogs.chooseSavePath(suggestedFileName(name));if(!chosen)throw Object.assign(new Error(),{code:'cancelled'});const path=/\.rwdoc$/i.test(chosen)?chosen:`${chosen}.rwdoc`;await library.assertNew(path);const answer=await askPassword({purpose:'create',name});if(!answer)throw Object.assign(new Error(),{code:'cancelled'});const made=await library.createVault(path,name,typeof answer==='string'?answer:answer.password);await recent.add(made.path);return{id:made.id};}},
    'credentials.folder':{keys:['id','expectedSeq','name','parentId'],changes:true,run:p=>{targetInput(p);return library.add(p.id as string,{type:'folder',parentId:p.parentId===undefined?null:p.parentId as string|null,name:checkName(p.name as string),props:{}});}},
    'credentials.edit':{keys:[...credentialKeys,'name','parentId'],changes:true,run:p=>credentialsService.edit(p)},
    'credentials.remove':{keys:credentialKeys,changes:true,run:p=>credentialsService.remove(p)},
    'credentials.analyze':{keys:['id','expectedSeq','expectedCredentialVersion','objectIds','optIn'],run:p=>credentialsService.analyze(p)},
    'credentials.candidates':{keys:['name','scopeVaultIds'],run:p=>credentialsService.candidates(p)},
    'credentials.effective':{keys:['id','expectedSeq','objectId'],run:p=>credentialsService.effective(p)},
    'credentials.group':{keys:['id','expectedSeq','objectId','group','inherit','value'],changes:true,run:p=>credentialsService.updateGroup(p)},
    'credentials.totpStatus':{keys:credentialKeys,run:p=>credentialsService.totpStatus(p)},
    'credentials.copyTotp':{keys:credentialKeys,changes:true,run:p=>credentialsService.copyTotp(p)},
    'credentials.mfa':{keys:['id','expectedSeq','objectId','config'],changes:true,run:p=>credentialsService.setMfa(p)},
    'templates.list':{keys:[],run:()=>templatesService.list()},
    'templates.capture':{keys:['id','expectedSeq','objectId','name','copyReferences'],changes:true,run:p=>templatesService.capture(p as Parameters<TemplateService['capture']>[0])},
    'templates.apply':{keys:['id','expectedSeq','templateHandle','templateId','parentId','name','values','fields'],changes:true,run:p=>templatesService.apply(p as Parameters<TemplateService['apply']>[0])},
    'templates.adHoc':{keys:['templateHandle','templateId','values','fields'],changes:true,run:p=>templatesService.adHoc(p as Parameters<TemplateService['adHoc']>[0])},
    'templates.remove':{keys:['id','expectedSeq','templateId'],changes:true,run:async p=>{const before=targetInput(p),node=before.doc.objects[p.templateId as string];if(node?.type!=='template')throw Object.assign(new Error(),{code:'invalid'});if(!await question(`Hapus template “${node.name}”?`,'Koneksi yang sudah dibuat dari template tetap ada.'))throw Object.assign(new Error(),{code:'cancelled'});if(library.privateDocument(p.id as string).generation!==before.generation)throw Object.assign(new Error(),{code:'stale'});return templatesService.remove(p as Parameters<TemplateService['remove']>[0]);}},
    'overrides.state':{keys:[],run:()=>{const {status,seq,dirty,conflicts,error,warnings}=privateOverlays!.state();return{status,seq,dirty,conflicts,...(error?{error}:{}),warnings};}},
    'overrides.create':{keys:[],changes:true,run:()=>privateOverlays!.create()},'overrides.unlock':{keys:[],changes:true,run:()=>privateOverlays!.unlock()},
    'overrides.lock':{keys:[],changes:true,run:()=>privateOverlays!.lock()},'overrides.disable':{keys:[],changes:true,run:()=>privateOverlays!.disable()},
    'overrides.save':{keys:['expectedSeq'],changes:true,run:p=>privateOverlays!.save(p as any)},
    'overrides.set':{keys:['id','expectedSeq','objectId','group','inherit','value','overlaySeq'],changes:true,run:p=>privateOverlays!.set(p)},
    'overrides.clear':{keys:['id','expectedSeq','objectId','group','overlaySeq'],changes:true,run:p=>privateOverlays!.clear(p as any)},
    'overrides.resolve':{keys:['key','choice','expectedSeq'],changes:true,run:p=>privateOverlays!.resolve(p as any)},
    'protocol.probe':{keys:['pluginType','host','port','username','path','jumpHost','jumpPassword','identityFile'],run:p=>probeProtocol(p)},
    'protocol.exec':{keys:['pluginType','host','port','username','password','jumpHost','identityFile','command'],run:p=>execProtocol(p)},
    'protocol.launch':{keys:['pluginType','host','port','username','jumpHost','jumpPassword','identityFile','path'],run:p=>launchExternalProtocol(p)},
    'ssh.env':{keys:[],run:()=>discoverSshEnvironment()},
    'gateway.add':{keys:['alias','hostName','port','user','identityFile','proxyJump'],run:p=>upsertCustomJumpHost(p)},
    'gateway.remove':{keys:['alias'],run:p=>removeCustomJumpHost(p)},
    'gateway.configure':{keys:['jumpHost','jumpPassword','identityFile'],run:p=>configureRdpGateway(p)},
    'tunnel.list':{keys:[],run:()=>listSshTunnels()},
    'tunnel.start':{keys:['mode','jumpHost','targetHost','targetPort','localPort','jumpPassword','identityFile'],run:p=>startSshTunnel(p)},
    'tunnel.stop':{keys:['id'],run:p=>stopSshTunnel(p)},
    'pty.open':{keys:['host','port','username','password','jumpHost','jumpPassword','identityFile','authMode','cols','rows'],run:p=>openPtySession(p)},
    'pty.read':{keys:['sessionId','waitMs'],run:p=>readPtySession(p)},
    'pty.write':{keys:['sessionId','data'],run:p=>writePtySession(p)},
    'pty.resize':{keys:['sessionId','cols','rows'],run:p=>resizePtySession(p)},
    'pty.close':{keys:['sessionId'],run:p=>closePtySession(p)},
    'vnc.open':{keys:['host','port','username','password','jumpHost','jumpPassword','identityFile'],run:p=>openVncSession(p)},
    'vnc.frame':{keys:['sessionId','sinceSeq','waitMs'],run:p=>readVncFrame(p)},
    'vnc.input':{keys:['sessionId','kind','x','y','buttonMask','down','keysym'],run:p=>sendVncInput(p)},
    'vnc.close':{keys:['sessionId'],run:p=>closeVncSession(p)},
    'ssh.knownHosts.list':{keys:[],run:()=>listKnownHostsAndCerts()},
    'ssh.knownHosts.remove':{keys:['lineNumber','hostPattern','certEndpoint'],run:p=>removeKnownHostOrCertPin(p)},
    'net.wol':{keys:['mac','broadcastHost','port','jumpHost','identityFile'],run:p=>sendWakeOnLan(p)},
    'net.knock':{keys:['host','sequence','delayMs','jumpHost'],run:p=>runPortKnock(p)},
    'net.scan':{keys:['targetRange','ports','timeoutMs','jumpHost'],run:p=>scanNetworkRange(p)},
    'ssh.config.read':{keys:[],run:()=>readSshConfigFile()},
    'ssh.config.upsert':{keys:['alias','hostName','user','port','identityFile','proxyJump','forwardAgent','serverAliveInterval'],run:p=>upsertSshConfigBlock(p)},
    'ssh.config.delete':{keys:['alias'],run:p=>deleteSshConfigBlock(p)},
    'sftp.local.list':{keys:['dirPath'],run:p=>listLocalDirectory(p)},
    'sftp.local.action':{keys:['action','filePath','content','mode'],run:p=>localFileAction(p)},
    'sftp.remote.action':{keys:['action','host','port','username','password','jumpHost','jumpPassword','identityFile','remotePath','localPath','content','mode'],run:p=>remoteFileAction(p)},
    'ssh.keys.list':{keys:[],run:()=>listSshKeyPairs()},
    'ssh.keys.generate':{keys:['name','algo','comment'],run:p=>generateSshKeyPair(p)},
    'ssh.keys.deploy':{keys:['keyName','host','port','username','password','jumpHost','jumpPassword'],run:p=>deploySshPublicKey(p)},
    'tls.audit':{keys:['host','port','jumpHost'],run:p=>auditTlsCertificateEndpoint(p)},
    'net.path':{keys:['target','mode','recordType','jumpHost'],run:p=>runNetworkPathAndDnsDiag(p)},
    'http.probe':{keys:['url','method','jumpHost'],run:p=>runHttpEndpointHealthProbe(p)},
    'ntp.audit':{keys:['host','username','jumpHost','identityFile'],run:p=>runFleetTimeSyncAudit(p)},
    'ssh.ca':{keys:['action','principals','validity','targetKey'],run:p=>manageSshCertificateAuthority(p)},
    'prom.scrape':{keys:['endpoint','jumpHost'],run:p=>runPrometheusScrape(p)},
    'vpn.wg.gen':{keys:['peerName','tunnelCidr','endpoint','allowedSubnets'],run:p=>generateWireGuardPeerBundle(p)},
    'alert.relay':{keys:['channel','target','message'],run:p=>sendAlertRelayTest(p)},
    'net.whois':{keys:['target'],run:p=>runIpWhoisAndAsnLookup(p)},
    'http.bench':{keys:['url','requests','concurrency'],run:p=>runHttpLoadBenchmark(p)},
    'vault.sync':{keys:['action','repoPath','payload'],run:p=>runTeamVaultGitSync(p)},
  }});

  ipcMain.handle('rdp:open',async(event,value)=>{check(event);const target=validateTarget(value);return connectQueue.run(async()=>{const secret=await credential(target);return openEngine(target,secret);},connectLifetime.signal);});
  ipcMain.handle('rdp:input',(event,id,value)=>{check(event);if(typeof id!=='string')throw new Error('Invalid session');sessions.get(id)?.send(validateInput(value));});
  ipcMain.on('rdp:frame-ack',(event,id,sequence)=>{try{check(event);}catch{return;}if(typeof id==='string'&&Number.isSafeInteger(sequence)&&sequence>0)deliveries.get(id)?.ack(sequence);});
  ipcMain.handle('rdp:activate',(event,id)=>{check(event);if(typeof id!=='string')throw new Error('Invalid session');gate.activate(id);});
  // Only a status word goes back to the renderer; clipboard text never does.
  ipcMain.handle('rdp:clipboard-sync',async(event,id)=>{check(event);if(typeof id!=='string')throw new Error('Invalid session');const s=sessions.get(id);return s?await gate.local(id,s):'closed';});
  ipcMain.handle('rdp:close',async(event,id)=>{check(event);if(typeof id!=='string')throw new Error('Invalid session');await closeEngine(id);});
  window.on('closed',()=>{connectLifetime.abort();for(const id of starting.keys())void closeEngine(id).catch(()=>reportProfileCleanup('RDP profile cleanup incomplete'));connects.close(operationOwner);bulk.close(operationOwner);transfer.close(operationOwner);plans.close();maintenance.close();if(settingsWindow&&!settingsWindow.isDestroyed())settingsWindow.close();shell?.stop();followed.stop();for(const d of deliveries.values())d.close();deliveries.clear();void closeProfiledSessions(sessions.values(),reportProfileCleanup);library.closeAll();});
  try{shell.start();}catch(error){console.error('[shell]',error);}   // whatever goes wrong with the menu, the page still loads
  await window.loadURL(localUrl);
});
app.on('window-all-closed',async()=>{await closeProfiledSessions(sessions.values(),reportProfileCleanup);app.quit();});
