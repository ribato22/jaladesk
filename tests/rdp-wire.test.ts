import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, FrameStream, validateInput, validateTarget, mapPointer } from '../src/protocols/rdp/wire.js';

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
