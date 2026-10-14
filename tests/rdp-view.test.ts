import test from 'node:test';import assert from 'node:assert/strict';
import {keyInput,makeInputState} from '../src/protocols/rdp/view.js';
import type {Input} from '../src/protocols/rdp/wire.js';
test('physical keys preserve release and extended arrow codes',()=>{
  assert.deepEqual(keyInput('KeyA',true),{type:'key',scanCode:30,down:true});
  assert.deepEqual(keyInput('ArrowLeft',false),{type:'key',scanCode:331,down:false});
  assert.equal(keyInput('Unidentified',true),undefined);
});
test('focus or capture loss releases mouse and keys to their original session once',()=>{
  const sentA:Input[]=[],sentB:Input[]=[];
  const a=makeInputState(v=>sentA.push(v)),b=makeInputState(v=>sentB.push(v));
  a.pointer({type:'pointer',x:40,y:50,buttons:1});a.key('ShiftLeft',true);
  a.release();b.key('KeyA',true);a.release();
  assert.deepEqual(sentA,[{type:'pointer',x:40,y:50,buttons:1},{type:'key',scanCode:42,down:true},{type:'pointer',x:40,y:50,buttons:0},{type:'key',scanCode:42,down:false}]);
  assert.deepEqual(sentB,[{type:'key',scanCode:30,down:true}]);
});
