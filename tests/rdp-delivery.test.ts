import test from 'node:test';import assert from 'node:assert/strict';
import {makeFrameDelivery} from '../src/protocols/rdp/delivery.js';
import type {Frame} from '../src/protocols/rdp/wire.js';
const frame=(v:number):Frame=>({width:1,height:1,rgba:Uint8Array.of(v,0,0,255)});
test('slow renderer receives one frame and only the latest pending after ACK',()=>{
  const sent:{frame:Frame;sequence:number}[]=[];const d=makeFrameDelivery((frame,sequence)=>sent.push({frame,sequence}));
  d.push(frame(1));for(let i=2;i<=100;i++)d.push(frame(i));
  assert.equal(sent.length,1);d.ack(999);assert.equal(sent.length,1);
  d.ack(sent[0].sequence);assert.equal(sent.length,2);assert.equal(sent[1].frame.rgba[0],100);
  d.ack(sent[0].sequence);assert.equal(sent.length,2);d.ack(sent[1].sequence);d.push(frame(101));assert.equal(sent.length,3);
});
test('close drops pending frames and ignores late ACK without affecting another session',()=>{
  const a:Frame[]=[],b:Frame[]=[];const da=makeFrameDelivery(f=>a.push(f)),db=makeFrameDelivery(f=>b.push(f));
  da.push(frame(1));da.push(frame(2));db.push(frame(3));db.push(frame(4));
  da.close();da.ack(1);da.push(frame(5));db.ack(1);
  assert.equal(a.length,1);assert.equal(b.length,2);assert.equal(b[1].rgba[0],4);
});
