import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import{isCommand,spec}from'../src/desktop/commands.js';
test('document properties is a document command with an accessible separate metadata dialog',()=>{
 assert.equal(isCommand('doc.properties'),true);assert.equal(spec('doc.properties' as any).button,'doc-properties-open');
 const html=readFileSync(new URL('../../src/desktop/index.html',import.meta.url),'utf8');assert.ok(html.includes('id="doc-properties-dialog"'));assert.ok(html.includes('id="doc-properties-error" role="alert"'));assert.ok(html.includes('Dibuat (UTC)'));
});

test('password change uses an application command and a status panel without exposing old or new password fields',()=>{
 assert.equal(isCommand('doc.password'),true);assert.equal(spec('doc.password' as any).button,'doc-password-open');const html=readFileSync(new URL('../../src/desktop/index.html',import.meta.url),'utf8');assert.ok(html.includes('id="document-maintenance-notices"'));assert.ok(html.includes('Revisi lama tetap memerlukan password lama'));assert.ok(!html.includes('id="old-password"'));assert.ok(!html.includes('id="new-password"'));
});

test('transfer is reachable from commands, dialog, renderer and guarded main routes',()=>{
 assert.equal(isCommand('obj.transfer'),true);assert.equal(spec('obj.transfer' as any).button,'obj-transfer');const read=(name:string)=>readFileSync(new URL('../../src/desktop/'+name,import.meta.url),'utf8');assert.ok(read('index.html').includes('id="transfer-dialog"'));assert.ok(read('renderer.ts').includes('initTransfer(configHost)'));for(const action of ['transfer.sources','transfer.preview','transfer.apply','transfer.cancel'])assert.ok(read('main.ts').includes("'"+action+"'"));assert.ok(read('menu-model.ts').includes("command('obj.transfer')"));assert.ok(read('context-menu.ts').includes("'obj.transfer'"));
});

test('batch UI and global connection FIFO reach manual, stored, ad hoc and bulk paths',()=>{assert.equal(isCommand('obj.bulk'),true);assert.equal(spec('obj.bulk' as any).button,'obj-bulk');const read=(name:string)=>readFileSync(new URL('../../src/desktop/'+name,import.meta.url),'utf8');assert.ok(read('index.html').includes('id="bulk-dialog"'));assert.ok(read('renderer.ts').includes('initBulk(configHost)'));for(const action of ['bulk.sources','bulk.preview','bulk.apply','bulk.progress','bulk.cancel','connects.start','connects.progress','connects.cancel','connects.retry','connects.disconnect'])assert.ok(read('main.ts').includes("'"+action+"'"));assert.ok(read('main.ts').includes('beforeSpawn(id)'));assert.ok(read('main.ts').includes('connectQueue.run'));assert.ok(read('preload.cjs').includes('onStoredOpened'));assert.ok(read('renderer.ts').includes('window.rdp.onStoredOpened'));});
