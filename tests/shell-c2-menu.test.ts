import test from 'node:test';import assert from 'node:assert/strict';import {buildMenu,findCommand} from '../src/desktop/menu-model.js';import {contextMenu} from '../src/desktop/context-menu.js';import {EMPTY_REPORT} from '../src/desktop/commands.js';
test('vault and template commands follow the same enabled controls in native and tree menus, and pause for a modal',()=>{
 const input:any={platform:'darwin',appName:'Fixture',report:{...EMPTY_REPORT,enabled:['doc.vault','obj.templates']},flags:{theme:'system',toolbar:true,fullscreen:false,prompt:false}};
 for(const id of ['doc.vault','obj.templates']){assert.equal(findCommand(buildMenu(input),id as any)?.enabled,true);assert.ok(contextMenu('tree',input).some(e=>e.kind==='command'&&e.id===id));assert.equal(findCommand(buildMenu({...input,flags:{...input.flags,prompt:true}}),id as any)?.enabled,false);}
});
