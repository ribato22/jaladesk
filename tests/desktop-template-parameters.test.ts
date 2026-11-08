import test from 'node:test';import assert from 'node:assert/strict';const path='../src/desktop/template-ui.js';
test('template expressions and typed public token values remain separate and do not read secret controls',async()=>{
 const {templateParameters}=await import(path);assert.equal(typeof templateParameters,'function');
 const entries:Record<string,string>={'tpl-expr-Name':'$Name$','tpl-expr-Host':'$Host$','tpl-expr-Port':'$Port$','tpl-token-Host':'example.invalid','tpl-token-Port':'4321','tpl-token-UserName':'lab','tpl-name':'New label'};
 const result=templateParameters((id:string)=>{assert.ok(!/password|seed|secret|private/i.test(id));return entries[id]??'';});
 assert.deepEqual(result,{fields:{Name:'$Name$',Host:'$Host$',Port:'$Port$'},values:{Name:'New label',Host:'example.invalid',Port:4321,UserName:'lab'}});
 assert.deepEqual(templateParameters(()=>''),{});
});
