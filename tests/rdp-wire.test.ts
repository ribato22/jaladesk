import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, FrameStream, validateInput, validateTarget, mapPointer, WHEEL_LIMIT } from '../src/protocols/rdp/wire.js';

function pixels() {
  const p = Buffer.alloc(20);
  p.writeUInt32LE(16, 0); p.writeUInt32LE(2, 4); p.writeUInt32LE(1, 8);
  p.set([255, 0, 0, 255, 0, 255, 0, 255], 12);
  return p;
}
test('preserves hand-checked RGBA pixels', () => {
  const f = decodeFrame(pixels());
  assert.deepEqual([f.width, f.height], [2, 1]);
  assert.deepEqual([...f.rgba], [255, 0, 0, 255, 0, 255, 0, 255]);
});
test('rejects missing pixels and invalid dimensions', () => {
  assert.throws(() => decodeFrame(pixels().subarray(0, 16)), /length/);
  for (const dimension of [0, 8193]) {
    const p = pixels(); p.writeUInt32LE(dimension, 4);
    assert.throws(() => decodeFrame(p), /dimension/);
  }
});
test('rejects attacker length header without allocating its claimed body', () => {
  const s = new FrameStream(); const header = Buffer.alloc(4);
  header.writeUInt32LE(0xffffffff);
  assert.throws(() => s.push(header), /budget/);
});
test('reassembles fragmented and consecutive frames', () => {
  const s = new FrameStream(); const packet = Buffer.concat([pixels(), pixels()]);
  const out = [];
  for (const byte of packet) out.push(...s.push(Buffer.from([byte])));
  s.finish(); assert.equal(out.length, 2);
  assert.deepEqual([...out[1].rgba], [255, 0, 0, 255, 0, 255, 0, 255]);
});
test('rejects a truncated stream at process exit', () => {
  const s = new FrameStream(); s.push(pixels().subarray(0, 13));
  assert.throws(() => s.finish(), /truncated/);
});
test('maps display scaling and rejects nonfinite geometry', () => {
  assert.deepEqual(mapPointer(110, 70, { left: 10, top: 20, width: 200, height: 100 }, {width:1000,height:500}),
    { type:'pointer', x:500, y:250, buttons:0 });
  assert.throws(() => mapPointer(0, 0, {left:0,top:0,width:0,height:100},{width:1,height:1}));
  assert.throws(() => mapPointer(NaN,0,{left:0,top:0,width:100,height:100},{width:1,height:1}));
});
test('rejects malformed target and input at the IPC boundary', () => {
  assert.throws(() => validateTarget({host:'x\ncommand',port:3389,username:'user'}));
  assert.throws(() => validateTarget({host:'host',port:0,username:'user'}));
  assert.throws(() => validateTarget({host:'host',port:3389,username:'user',certificateSha256:'bad'}));
  assert.throws(() => validateInput({type:'key',scanCode:Infinity,down:true}));
  assert.throws(() => validateInput({type:'pointer',x:-1,y:0,buttons:0}));
  assert.deepEqual(validateInput({type:'close'}),{type:'close'});
});
test('resize input stays inside the display-control bounds', () => {
  assert.deepEqual(validateInput({type:'resize',width:1280,height:720}),{type:'resize',width:1280,height:720});
  for (const [width,height] of [[199,720],[1280,199],[8193,720],[1280,8193],[1280.5,720],[0,0]])
    assert.throws(() => validateInput({type:'resize',width,height}), /invalid integer/);
  // a desktop larger than one frame may carry would end the session on the first repaint
  assert.deepEqual(validateInput({type:'resize',width:8192,height:4092}),{type:'resize',width:8192,height:4092});
  for (const [width,height] of [[8192,8192],[8192,4097],[6000,5600]])
    assert.throws(() => validateInput({type:'resize',width,height}), /invalid size/);
});
test('target carries an optional initial desktop size and an explicit text-clipboard opt-in', () => {
  const base = {host:'host',port:3389,username:'user'};
  assert.deepEqual(validateTarget(base), base);
  assert.deepEqual(validateTarget({...base,width:1024,height:768}), {...base,width:1024,height:768});
  const one = {toRemote:true,fromRemote:false};
  assert.deepEqual(validateTarget({...base,clipboard:one}), {...base,clipboard:one});
  assert.deepEqual(validateTarget({...base,clipboard:{toRemote:false,fromRemote:false}}), base);
  for (const bad of [{width:1024},{height:768},{width:199,height:768},{width:4097,height:768},{width:1024,height:2049},{width:1024.5,height:768},
    {clipboard:true},{clipboard:{toRemote:'yes',fromRemote:false}},{clipboard:{toRemote:true}},{clipboard:{toRemote:true,fromRemote:false,files:true}}])
    assert.throws(() => validateTarget({...base,...bad}), Error, JSON.stringify(bad));
});
test('a reset stream drops its partial frame and decodes the next one from scratch', () => {
  const s = new FrameStream(); s.push(pixels().subarray(0, 15)); s.reset();
  s.finish();
  assert.deepEqual(s.push(pixels()).map(f => [f.width, f.height]), [[2, 1]]);
});
test('wheel input carries a position and one signed count of 1/120 notches, never zero and never beyond the helper limit', () => {
  assert.equal(WHEEL_LIMIT, 4800);   // native/rdp/control.hpp WHEEL_MAX_DELTA: both sides must agree
  assert.deepEqual(validateInput({type:'wheel',x:10,y:20,delta:-120}), {type:'wheel',x:10,y:20,delta:-120});
  assert.deepEqual(validateInput({type:'wheel',x:8191,y:0,delta:4800}), {type:'wheel',x:8191,y:0,delta:4800});
  assert.deepEqual(validateInput({type:'wheel',x:0,y:8191,delta:-4800}), {type:'wheel',x:0,y:8191,delta:-4800});
  const ok = {type:'wheel',x:10,y:20,delta:-120};
  for (const bad of [{delta:0},{delta:4801},{delta:-4801},{delta:1.5},{delta:'120'},{delta:NaN},{delta:Infinity},{delta:undefined},
    {x:-1},{x:8192},{x:1.5},{x:'1'},{y:-1},{y:8192},{y:undefined}])
    assert.throws(() => validateInput({...ok,...bad}), /invalid integer/, JSON.stringify(bad));
  // extra fields are not passed on to the helper
  assert.deepEqual(validateInput({...ok,buttons:7,extra:'x'}), ok);
});
test('horizontal wheel input is a wheel under its own type: one signed count, positive turns right, never zero, same limit as the vertical wheel', () => {
  assert.deepEqual(validateInput({type:'hwheel',x:10,y:20,delta:120}), {type:'hwheel',x:10,y:20,delta:120});
  assert.deepEqual(validateInput({type:'hwheel',x:8191,y:0,delta:4800}), {type:'hwheel',x:8191,y:0,delta:4800});
  assert.deepEqual(validateInput({type:'hwheel',x:0,y:8191,delta:-4800}), {type:'hwheel',x:0,y:8191,delta:-4800});
  const ok = {type:'hwheel',x:10,y:20,delta:-120};
  for (const bad of [{delta:0},{delta:4801},{delta:-4801},{delta:1.5},{delta:'120'},{delta:NaN},{delta:Infinity},{delta:undefined},
    {x:-1},{x:8192},{x:1.5},{x:'1'},{y:-1},{y:8192},{y:undefined}])
    assert.throws(() => validateInput({...ok,...bad}), /invalid integer/, JSON.stringify(bad));
  assert.deepEqual(validateInput({...ok,buttons:7,extra:'x'}), ok);   // extra fields are not passed on to the helper
  // the axes stay apart: each type keeps its own name on the way to the helper, and a made-up axis is refused
  assert.equal(validateInput({type:'wheel',x:1,y:1,delta:1}).type, 'wheel');
  assert.equal(validateInput({type:'hwheel',x:1,y:1,delta:1}).type, 'hwheel');
  for (const type of ['xwheel','vwheel','wheel2','']) assert.throws(() => validateInput({type,x:1,y:1,delta:1}), /invalid input/, type);
});
