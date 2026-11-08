import test from 'node:test';import assert from 'node:assert/strict';
import {activationTimeout,desktopSize,initialDesktop,keyCodes,keyInput,makeInputState,makeResizeScheduler,reasonText,reconnectable,tabAfterClose,tabLabel,takeoverHint,takeoverWindowMs,hwheelUnits,wheelUnits,type TabInfo} from '../src/protocols/rdp/view.js';
import {WHEEL_LIMIT,type Input} from '../src/protocols/rdp/wire.js';
test('physical keys preserve release and extended arrow codes',()=>{
  assert.deepEqual(keyInput('KeyA',true),{type:'key',scanCode:30,down:true});
  assert.deepEqual(keyInput('ArrowLeft',false),{type:'key',scanCode:331,down:false});
  assert.equal(keyInput('Unidentified',true),undefined);
});
test('function, lock and keypad keys reach the remote under their own scancodes',()=>{
  const scan=(code:string)=>(keyInput(code,true) as {scanCode:number}|undefined)?.scanCode;
  assert.deepEqual(Array.from({length:12},(_,n)=>scan(`F${n+1}`)),[59,60,61,62,63,64,65,66,67,68,87,88]);
  assert.deepEqual([scan('CapsLock'),scan('NumLock')],[58,69]);
  // The keypad digits keep the navigation-cluster scancodes: the remote's own NumLock state decides digit or arrow.
  assert.deepEqual(Array.from({length:10},(_,n)=>scan(`Numpad${n}`)),[82,79,80,81,75,76,77,71,72,73]);
  assert.deepEqual([scan('NumpadDecimal'),scan('NumpadSubtract'),scan('NumpadAdd'),scan('NumpadMultiply')],[83,74,78,55]);
  // Keypad Enter and keypad divide share their scancode with a main key and are told apart by the extended flag (0x100).
  assert.deepEqual([scan('NumpadEnter'),scan('NumpadDivide')],[0x11c,0x135]);
});
test('every mapped physical key has a scancode of its own, inside what the helper accepts',()=>{
  assert.ok(keyCodes.length>=100,'the key table must be exported for this guard');
  const seen=new Map<number,string>();
  for(const code of keyCodes){
    const input=keyInput(code,true)!;
    assert.ok(input.type==='key'&&input.scanCode>=1&&input.scanCode<=511,code);
    if(input.type==='key'){assert.equal(seen.get(input.scanCode),undefined,`${code} reuses the scancode of ${seen.get(input.scanCode)}`);seen.set(input.scanCode,code);}
  }
});
test('focus or capture loss releases mouse and keys to their original session once',()=>{
  const sentA:Input[]=[],sentB:Input[]=[];
  const a=makeInputState(v=>sentA.push(v)),b=makeInputState(v=>sentB.push(v));
  a.pointer({type:'pointer',x:40,y:50,buttons:1});a.key('ShiftLeft',true);
  a.release();b.key('KeyA',true);a.release();
  assert.deepEqual(sentA,[{type:'pointer',x:40,y:50,buttons:1},{type:'key',scanCode:42,down:true},{type:'pointer',x:40,y:50,buttons:0},{type:'key',scanCode:42,down:false}]);
  assert.deepEqual(sentB,[{type:'key',scanCode:30,down:true}]);
});
test('a Command key held while the window loses focus is never forwarded: switching apps must not tap the Windows key',()=>{
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.key('MetaLeft',true);state.key('MetaLeft',true);   // key repeat
  state.release();                                          // Cmd+Tab: the window blurs while Cmd is down
  state.key('MetaLeft',false);                              // Cmd released back in the app, nothing was ever pressed remotely
  assert.deepEqual(sent,[]);
});
test('a Command key used with another key reaches the remote as a chord, in order',()=>{
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.key('MetaLeft',true);state.key('KeyR',true);state.key('KeyR',false);state.key('MetaLeft',false);
  assert.deepEqual(sent,[{type:'key',scanCode:347,down:true},{type:'key',scanCode:19,down:true},{type:'key',scanCode:19,down:false},{type:'key',scanCode:347,down:false}]);
});
test('a deliberate tap of the Command key is a press and a release, and a blur after a chord releases both keys',()=>{
  const tap:Input[]=[];const a=makeInputState(v=>tap.push(v));
  a.key('MetaRight',true);a.key('MetaRight',false);
  assert.deepEqual(tap,[{type:'key',scanCode:348,down:true},{type:'key',scanCode:348,down:false}]);
  const chord:Input[]=[];const b=makeInputState(v=>chord.push(v));
  b.key('MetaLeft',true);b.key('KeyE',true);b.release();
  assert.deepEqual(chord,[{type:'key',scanCode:347,down:true},{type:'key',scanCode:18,down:true},{type:'key',scanCode:347,down:false},{type:'key',scanCode:18,down:false}]);
});
test('viewport becomes an even desktop size inside the protocol bounds and the frame budget', () => {
  assert.deepEqual(desktopSize(1000.7,600.2),{width:1000,height:600});
  assert.deepEqual(desktopSize(1001,601),{width:1000,height:601});
  assert.deepEqual(desktopSize(50,50),{width:200,height:200});
  assert.deepEqual(desktopSize(9000,9000),{width:5792,height:5792});
  for (const [w,h] of [[8192,8192],[8192,4096],[7680,4320],[6016,3384],[8000,5000]]) {
    const size=desktopSize(w,h)!;
    assert.ok(size.width*size.height*4+8<=128*1024*1024&&size.width%2===0&&size.width>=200&&size.height>=200,`${w}x${h}`);
  }
  assert.deepEqual(desktopSize(5120,2880),{width:5120,height:2880});
  for (const [w,h] of [[NaN,600],[800,Infinity],[0,600],[-5,600]]) assert.equal(desktopSize(w,h),undefined);
});
function fakeTimers() {
  let now=0,id=0;const queue=new Map<number,{at:number;fn:()=>void}>();
  return {
    set(fn:()=>void,ms:number){queue.set(++id,{at:now+ms,fn});return id;},
    clear(handle:unknown){queue.delete(handle as number);},
    advance(ms:number){now+=ms;for(const [key,t] of [...queue].sort((a,b)=>a[1].at-b[1].at))if(t.at<=now){queue.delete(key);t.fn();}}
  };
}
test('resize scheduler debounces to the last viewport, skips the size already in effect and can be cancelled', () => {
  const t=fakeTimers(),sent:{width:number;height:number}[]=[];
  const s=makeResizeScheduler(size=>sent.push(size),t,500);
  s.observe({width:1000,height:600});t.advance(200);s.observe({width:1100,height:650});t.advance(200);s.observe({width:1200,height:700});
  t.advance(499);assert.equal(sent.length,0);t.advance(1);
  assert.deepEqual(sent,[{width:1200,height:700}]);
  s.observe({width:1200,height:700});t.advance(1000);assert.equal(sent.length,1);
  s.baseline({width:1200,height:700});
  s.observe({width:1000,height:600});s.observe({width:1200,height:700});t.advance(1000);assert.equal(sent.length,1);
  s.observe({width:1300,height:720});s.cancel();t.advance(1000);assert.equal(sent.length,1);
  s.observe({width:Number.NaN,height:720});t.advance(1000);assert.equal(sent.length,1);
});
test('a second tab to the same host gets a number, and a number that was freed is reused', () => {
  assert.equal(tabLabel('10.28.0.173',[]),'10.28.0.173');
  assert.equal(tabLabel('10.28.0.173',['10.28.0.173']),'10.28.0.173 (2)');
  assert.equal(tabLabel('10.28.0.173',['10.28.0.173','10.28.0.173 (2)']),'10.28.0.173 (3)');
  assert.equal(tabLabel('10.28.0.173',['10.28.0.173 (2)']),'10.28.0.173');   // the first tab was closed
  assert.equal(tabLabel('b',['a','a (2)']),'b');
});
// A finished tab (closed or failed) can be closed. The tab shown afterwards is its right neighbour, else its left neighbour, else none.
test('closing a tab shows its right neighbour, else its left neighbour, else nothing', () => {
  assert.equal(tabAfterClose(['a','b','c'],'b'),'c');
  assert.equal(tabAfterClose(['a','b','c'],'c'),'b');
  assert.equal(tabAfterClose(['a','b','c'],'a'),'b');
  assert.equal(tabAfterClose(['a'],'a'),'');
  assert.equal(tabAfterClose(['a','b'],'x'),'');   // a tab that is not in the strip: nothing to choose
});
// Servers give an account one session and attach the newer connection to it, ending the older one: the lab's Windows Server 2019 does so
// and says only "disconnected" (error info 1). So a tab the server ended names the newer tab of the same host, port and user as the likely cause.
const tabInfo=(over:Partial<TabInfo>={}):TabInfo=>({label:'10.28.0.173',host:'10.28.0.173',port:4321,username:'administrator',state:'connected',started:1000,...over});
const hint=(label:string)=>`Kemungkinan tab “${label}”, yang baru menyambung ke host dan akun yang sama, mengambil alih sesi ini.`;
test('a tab the server ended names the newer tab of the same account as the likely cause',()=>{
  const ended=tabInfo(),newer=tabInfo({label:'10.28.0.173 (2)',started:2000});
  for(const reason of ['admin-disconnect','other-connection','server-closed'])assert.equal(takeoverHint(ended,reason,3000,[newer]),hint('10.28.0.173 (2)'),reason);
  assert.equal(takeoverHint(ended,'admin-disconnect',3000,[tabInfo({label:'a',started:1500}),newer,tabInfo({label:'b',started:1800})]),hint('10.28.0.173 (2)'),'the newest candidate is named');
  assert.equal(takeoverHint(ended,'admin-disconnect',3000,[tabInfo({label:'(2)',started:2000,state:'connecting'})]),hint('(2)'),'a tab still connecting counts');
  assert.equal(takeoverHint(tabInfo({host:'MSSQL-Bridge',username:'Administrator'}),'admin-disconnect',3000,[tabInfo({label:'(2)',started:2000,host:'mssql-bridge',username:'ADMINISTRATOR'})]),hint('(2)'),'user names and hosts are compared without case');
});
test('no takeover hint when the reason, the target, the age or the state of the other tab does not fit',()=>{
  const ended=tabInfo(),newer=tabInfo({label:'(2)',started:2000}),none=(reason:string,others:TabInfo[],now=3000)=>assert.equal(takeoverHint(ended,reason,now,others),undefined,JSON.stringify([reason,others,now]));
  for(const reason of ['logoff','timeout','server-denied','connection','authentication','helper-exit'])none(reason,[newer]);   // a takeover is not what these say
  none('admin-disconnect',[]);
  none('admin-disconnect',[tabInfo({started:2000,host:'10.28.0.174'})]);
  none('admin-disconnect',[tabInfo({started:2000,port:4322})]);
  none('admin-disconnect',[tabInfo({started:2000,username:'other'})]);
  none('admin-disconnect',[tabInfo({started:2000,state:'closed'})]);
  none('admin-disconnect',[tabInfo({started:2000,state:'failed'})]);
  none('admin-disconnect',[tabInfo({started:1000})]);                  // not newer: opened at the same time
  none('admin-disconnect',[tabInfo({started:500})]);                   // older: it cannot have taken over
  none('admin-disconnect',[newer],1999);                               // it opened after the session ended
  none('admin-disconnect',[newer],2000+takeoverWindowMs+1);            // not "just now" any more
  assert.equal(takeoverHint(ended,'admin-disconnect',2000+takeoverWindowMs,[newer]),hint('(2)'),'the window includes its end');
});
// The status line reads "<state> — <reason text> (kode 0x...)". FreeRDP gives everything after the security layer a fixed wait and then fails
// with ERRCONNECT_ACTIVATION_TIMEOUT, which the helper reports as a plain connection failure; on a slow path that is the whole story.
const slowText='Jaringan atau server terlalu lambat: sesi tidak selesai dibentuk dalam batas waktu. Coba lagi saat jaringan lebih cepat.';
test('a connect that ran out of time in FreeRDP says the network or server is too slow and what to do',()=>{
  assert.equal(activationTimeout,0x0002001c);
  assert.equal(reasonText('connection',activationTimeout),slowText);
  assert.notEqual(reasonText('connection',activationTimeout),reasonText('connection'),'it must differ from the generic connection text');
});
test('every other reason keeps its own text, with or without a code, and an unknown reason falls back to a retry hint',()=>{
  const texts:Record<string,string>={certificate:'Sertifikat tidak dipercaya atau pin tidak sesuai.',authentication:'Autentikasi ditolak.',connection:'Sesi gagal dibentuk atau terputus.','helper-start':'Bridge native belum tersedia. Jalankan build native.','helper-exit':'Proses koneksi berhenti.','connection-timeout':'Koneksi melewati batas waktu.','resize-reconnect':'Ukuran desktop baru memerlukan koneksi ulang.','frame-protocol':'Data layar remote tidak valid.','helper-failure':'Proses koneksi melaporkan kesalahan.','control-protocol':'Kontrol koneksi tidak valid.','other-connection':'Koneksi lain dengan akun yang sama mengambil alih sesi ini.',logoff:'Server meng-logoff sesi ini.','admin-disconnect':'Sesi diputus dari sisi server (oleh administrator atau pengguna).',timeout:'Batas waktu server tercapai (idle atau logon).','server-denied':'Server menolak sesi ini (hak akses atau kredensial).','server-closed':'Server menutup sesi ini.'};
  for(const [reason,text] of Object.entries(texts)){assert.equal(reasonText(reason),text,reason);assert.equal(reasonText(reason,0x00020006),text,reason+' with another code');}
  assert.equal(reasonText('something-new'),'Coba hubungkan kembali.');
  assert.equal(reasonText('something-new',activationTimeout),'Coba hubungkan kembali.','an unknown reason is not guessed from the code');
});
test('the slow-path text is only for a connection that failed with that exact code',()=>{
  for(const code of [0,0xc,0x00020006,0x00020014,0x0002001b,0x0002001d,0x0001001c,0x1c])assert.equal(reasonText('connection',code),'Sesi gagal dibentuk atau terputus.','code 0x'+code.toString(16));
  for(const reason of ['authentication','certificate','logoff','server-closed','helper-exit','connection-timeout'])assert.notEqual(reasonText(reason,activationTimeout),slowText,reason);
});
test('only finished sessions can be reconnected', () => {
  assert.deepEqual((['connecting','connected','closed','failed'] as const).map(reconnectable),[false,false,true,true]);
});
test('a frame arriving while a resize is pending does not cancel it, but one that already matches does', () => {
  const t=fakeTimers(),sent:{width:number;height:number}[]=[];
  const s=makeResizeScheduler(size=>sent.push(size),t,500);
  s.baseline({width:1280,height:720});s.observe({width:1000,height:600});
  t.advance(300);s.baseline({width:1280,height:720});t.advance(200);
  assert.deepEqual(sent,[{width:1000,height:600}]);
  s.observe({width:900,height:500});t.advance(100);s.baseline({width:900,height:500});t.advance(1000);
  assert.equal(sent.length,1);
});
test('the initial desktop is clamped to what the connection handshake accepts', () => {
  assert.deepEqual(initialDesktop({width:1000.9,height:600.2}),{width:1000,height:600});
  assert.deepEqual(initialDesktop({width:6000,height:5000}),{width:4096,height:2048});
  assert.deepEqual(initialDesktop({width:Number.NaN,height:600}),{});
});
test('restoring the old size while a resize is still being applied sends the correction', () => {
  const t=fakeTimers(),sent:{width:number;height:number}[]=[];
  const s=makeResizeScheduler(size=>sent.push(size),t,500);
  const old={width:1000,height:600},big={width:1600,height:900};
  s.baseline(old);s.observe(big);t.advance(500);
  assert.deepEqual(sent,[big]);
  s.baseline(old);                    // frames of the old size keep arriving until the server finishes
  s.observe(old);t.advance(500);      // the user restores the window before that
  assert.deepEqual(sent,[big,old]);
  s.baseline(old);s.observe(old);t.advance(500);          // the server answered with the size we last asked for
  assert.equal(sent.length,2);
  s.observe(big);t.advance(500);s.baseline(big);s.observe(big);t.advance(500);   // a frame of the requested size ends the request
  assert.deepEqual(sent,[big,old,big]);
});
test('browser wheel deltas become signed 1/120-notch units: scrolling down is negative, a notch is 120', () => {
  assert.equal(wheelUnits(100,0),-120);    // pixels: Chromium counts 100 per notch of a mouse wheel
  assert.equal(wheelUnits(-100,0),120);
  assert.equal(wheelUnits(50,0),-60);
  assert.equal(wheelUnits(3,1),-120);      // lines: Windows scrolls 3 per notch
  assert.equal(wheelUnits(-3,1),120);
  assert.equal(wheelUnits(1,2),-360);      // pages count as three notches
  assert.equal(wheelUnits(0,0),0);         // plain zero, never -0
  for (const bad of [NaN,Infinity,-Infinity]) assert.equal(wheelUnits(bad,0),0);
  assert.equal(wheelUnits(1e9,0),-WHEEL_LIMIT);
  assert.equal(wheelUnits(-1e9,1),WHEEL_LIMIT);
  assert.equal(wheelUnits(5,0),-6);
});
test('a wheel turn reaches the remote at the pointer position, in the direction it was turned', () => {
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.wheel(10,20,100,0);state.wheel(30,40,-100,0);state.wheel(30,40,3,1);
  assert.deepEqual(sent,[{type:'wheel',x:10,y:20,delta:-120},{type:'wheel',x:30,y:40,delta:120},{type:'wheel',x:30,y:40,delta:-120}]);
});
test('small trackpad deltas add up: nothing is sent for less than one unit, nothing is lost, nothing is added', () => {
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.wheel(1,1,0.3,0);state.wheel(1,1,0.3,0);
  assert.equal(sent.length,0);                               // 0.36 + 0.36 units: not a whole unit yet
  state.wheel(1,1,0.3,0);
  assert.deepEqual(sent,[{type:'wheel',x:1,y:1,delta:-1}]);  // 1.08 units
  sent.length=0;
  for(let n=0;n<100;n++)state.wheel(5,6,1,0);                // a hundred one-pixel steps = 120 units, give or take the carried fraction
  let total=0;
  for(const input of sent){assert.ok(input.type==='wheel'&&input.delta!==0&&Number.isInteger(input.delta),'every event is a whole, non-zero count');if(input.type==='wheel')total+=input.delta;}
  assert.ok(Math.abs(total+120)<=1,`sent ${total}`);
});
test('a wheel flick is limited to what the helper accepts, whatever the browser reports', () => {
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.wheel(1,1,1e7,0);state.wheel(1,1,-1e7,1);state.wheel(1,1,NaN,0);
  assert.deepEqual(sent,[{type:'wheel',x:1,y:1,delta:-WHEEL_LIMIT},{type:'wheel',x:1,y:1,delta:WHEEL_LIMIT}]);
});
test('browser horizontal deltas become signed 1/120-notch units: scrolling right is positive on both sides', () => {
  assert.equal(hwheelUnits(100,0),120);     // pixels: 100 per notch, the same scale as the vertical wheel
  assert.equal(hwheelUnits(-100,0),-120);
  assert.equal(hwheelUnits(50,0),60);
  assert.equal(hwheelUnits(3,1),120);       // lines
  assert.equal(hwheelUnits(-3,1),-120);
  assert.equal(hwheelUnits(1,2),360);       // pages count as three notches
  assert.equal(hwheelUnits(0,0),0);         // plain zero, never -0
  assert.equal(hwheelUnits(-0,0),0);
  assert.ok(Object.is(hwheelUnits(-0,0),0)&&Object.is(wheelUnits(0,0),0),'+0, not -0');
  for (const bad of [NaN,Infinity,-Infinity]) assert.equal(hwheelUnits(bad,0),0);
  assert.equal(hwheelUnits(1e9,0),WHEEL_LIMIT);
  assert.equal(hwheelUnits(-1e9,1),-WHEEL_LIMIT);
  assert.equal(hwheelUnits(5,0),6);
  // the vertical wheel keeps its own flipped sign
  assert.equal(wheelUnits(100,0),-120);
});
test('a horizontal turn reaches the remote at the pointer position, right as positive and left as negative', () => {
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.hwheel(10,20,100,0);state.hwheel(30,40,-100,0);state.hwheel(30,40,3,1);
  assert.deepEqual(sent,[{type:'hwheel',x:10,y:20,delta:120},{type:'hwheel',x:30,y:40,delta:-120},{type:'hwheel',x:30,y:40,delta:120}]);
});
test('the two axes carry their own fractions: a sideways nudge never turns into vertical movement and back', () => {
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.wheel(1,1,0.5,0);state.hwheel(1,1,0.5,0);                // -0.6 and +0.6 units: neither axis has a whole unit yet
  assert.equal(sent.length,0);
  state.wheel(1,1,0.5,0);                                        // -1.2 units: one unit down, 0.2 carried
  assert.deepEqual(sent,[{type:'wheel',x:1,y:1,delta:-1}]);
  state.hwheel(1,1,0.5,0);                                       // +1.2 units on its own axis
  assert.deepEqual(sent,[{type:'wheel',x:1,y:1,delta:-1},{type:'hwheel',x:1,y:1,delta:1}]);
  sent.length=0;
  for(let n=0;n<100;n++)state.hwheel(5,6,1,0);                   // a hundred one-pixel steps = 120 units, give or take the carried fraction
  let total=0;
  for(const input of sent){assert.ok(input.type==='hwheel'&&input.delta!==0&&Number.isInteger(input.delta),'every event is a whole, non-zero count');if(input.type==='hwheel')total+=input.delta;}
  assert.ok(Math.abs(total-120)<=1,`sent ${total}`);
});
test('a horizontal flick is limited to what the helper accepts, whatever the browser reports', () => {
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.hwheel(1,1,1e7,0);state.hwheel(1,1,-1e7,1);state.hwheel(1,1,NaN,0);
  assert.deepEqual(sent,[{type:'hwheel',x:1,y:1,delta:WHEEL_LIMIT},{type:'hwheel',x:1,y:1,delta:-WHEEL_LIMIT}]);
});
test('a pinch (a wheel turn with Ctrl that no Ctrl key press announced) presses Ctrl around the turn, once per turn', () => {
  const ctrlDown:Input={type:'key',scanCode:29,down:true},ctrlUp:Input={type:'key',scanCode:29,down:false};
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.wheel(10,20,-100,0,true);                                // pinch out = zoom in = wheel up with Ctrl
  assert.deepEqual(sent,[ctrlDown,{type:'wheel',x:10,y:20,delta:120},ctrlUp]);
  sent.length=0;state.hwheel(10,20,100,0,true);
  assert.deepEqual(sent,[ctrlDown,{type:'hwheel',x:10,y:20,delta:120},ctrlUp]);
  sent.length=0;state.wheel(10,20,-100,0,true);state.wheel(10,20,-100,0,true);
  assert.deepEqual(sent,[ctrlDown,{type:'wheel',x:10,y:20,delta:120},ctrlUp,ctrlDown,{type:'wheel',x:10,y:20,delta:120},ctrlUp]);   // no state left over between turns
  sent.length=0;state.release();
  assert.deepEqual(sent,[],'nothing is left pressed for release() to let go of');
});
test('Ctrl is not pressed around a turn when it is not Ctrl, when there is nothing to send, or when the user already holds it', () => {
  const sent:Input[]=[];const state=makeInputState(v=>sent.push(v));
  state.wheel(1,1,-100,0);state.wheel(1,1,-100,0,false);state.hwheel(1,1,100,0,false);   // plain turns carry no Ctrl events
  assert.deepEqual(sent.map(i=>i.type),['wheel','wheel','hwheel']);
  sent.length=0;state.wheel(1,1,0.3,0,true);state.hwheel(1,1,0.3,0,true);                 // a pinch step below one unit sends nothing at all, not even Ctrl
  assert.equal(sent.length,0);
  for(const [code,scanCode] of [['ControlLeft',29],['ControlRight',285]] as const){
    const held:Input[]=[];const real=makeInputState(v=>held.push(v));
    real.key(code,true);real.wheel(1,2,-100,0,true);real.hwheel(1,2,100,0,true);
    assert.deepEqual(held,[{type:'key',scanCode,down:true},{type:'wheel',x:1,y:2,delta:120},{type:'hwheel',x:1,y:2,delta:120}],`${code} is held by the user: no extra Ctrl events`);
    held.length=0;real.key(code,false);real.wheel(1,2,-100,0,true);                        // released again: a pinch needs its own Ctrl
    assert.deepEqual(held.map(i=>i.type),['key','key','wheel','key']);
  }
});
