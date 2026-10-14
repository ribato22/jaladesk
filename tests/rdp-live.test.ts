import test from 'node:test';import assert from 'node:assert/strict';
import {gateReady} from '../src/protocols/rdp/acceptance.js';
test('fixture and missing platform evidence cannot pass live acceptance',()=>{
  assert.equal(gateReady([{platform:'mac-arm64',status:'lab-passed',evidence:['lab.json']},{platform:'mac-x86_64',status:'fixture-tested',evidence:['fixture.png']},{platform:'windows-x64',status:'not-run',evidence:[]}]),false);
});
test('duplicate platform, missing evidence and missing checks fail the gate',()=>{
  const platforms=['mac-arm64','mac-x86_64','windows-x64'];const checks=['login','wrong-credentials','certificate-mismatch','embedded-input','resize','two-sessions','cancel','helper-crash','network-interruption','clipboard'];
  const valid=platforms.map(platform=>({platform,status:'lab-passed',evidence:['sanitized-lab.json'],checks}));
  assert.equal(gateReady(valid),true);assert.equal(gateReady([...valid,valid[0]]),false);
  assert.equal(gateReady(valid.map(r=>({...r,evidence:[]}))),false);
  assert.equal(gateReady(valid.map(r=>({...r,checks:['login']}))),false);
});
