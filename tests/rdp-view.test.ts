import test from 'node:test';import assert from 'node:assert/strict';
import {keyInput} from '../src/protocols/rdp/view.js';
test('physical keys preserve release and extended arrow codes',()=>{
  assert.deepEqual(keyInput('KeyA',true),{type:'key',scanCode:30,down:true});
  assert.deepEqual(keyInput('ArrowLeft',false),{type:'key',scanCode:331,down:false});
  assert.equal(keyInput('Unidentified',true),undefined);
});
