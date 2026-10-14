import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';import {resolve} from 'node:path';
import {decodeFrame} from '../src/protocols/rdp/wire.js';
const binary=resolve('native/bin',process.platform==='win32'?'rdp-bridge.exe':'rdp-bridge');
test('built native fixture emits the independently expected RGBA packet',{skip:!existsSync(binary)},()=>{
  const result=spawnSync(binary,['--fixture'],{input:'{"type":"connect"}\n{"type":"close"}\n',timeout:4000});
  assert.equal(result.status,0);const frame=decodeFrame(result.stdout);
  assert.deepEqual([...frame.rgba],[255,0,0,255,0,255,0,255]);
  assert.match(result.stderr.toString(),/"state":"connected"/);
});
test('native helper rejects oversized controls without echoing secret data',{skip:!existsSync(binary)},()=>{
  const result=spawnSync(binary,['--bridge-v1'],{input:'sensitive-marker'.repeat(5000)+'\n',timeout:4000});
  assert.equal(result.status,2);assert.equal(result.stdout.length,0);
  assert.equal(result.stderr.includes('sensitive-marker'),false);assert.match(result.stderr.toString(),/control-protocol/);
});
test('native loopback refusal preserves frame channel and suppresses inherited trace logging',{skip:!existsSync(binary)},()=>{
  const connect={type:'connect',target:{host:'127.0.0.1',port:1,username:'fixture'},secret:{password:'sensitive-marker',domain:''}};
  const result=spawnSync(binary,['--bridge-v1'],{input:JSON.stringify(connect)+'\n',timeout:4000,env:{...process.env,WLOG_LEVEL:'TRACE',WLOG_FILTER:'*:TRACE'}});
  assert.equal(result.stdout.length,0);assert.equal(result.stderr.includes('sensitive-marker'),false);
  for(const line of result.stderr.toString().trim().split('\n'))assert.ok(JSON.parse(line).state);
});
