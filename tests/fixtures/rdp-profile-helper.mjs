import {mkdir} from 'node:fs/promises';
const mode=process.argv[2];let text='';
process.stdin.setEncoding('utf8');process.stdin.on('data',b=>{text+=b;});
process.stdin.on('end',async()=>{
  const q=JSON.parse(text);
  if(mode==='hang'){setInterval(()=>{},1000);return;}
  if(q.op==='create')await mkdir(q.path,{mode:0o700});
  const v={schema:1,op:q.op,requestId:q.requestId,owner:true,private:true};
  let out=JSON.stringify(v)+'\n';
  if(mode==='duplicate')out=out.replace('"schema":1','"schema":0,"schema":1');
  if(mode==='wrong-id')v.requestId='00000000-0000-4000-8000-000000000000';
  if(mode==='unknown')v.extra=true;
  if(mode==='stderr')process.stderr.write('synthetic-warning\n');
  if(mode==='oversize')out=' '.repeat(4097);
  if(mode==='truncated')out='{';
  if(mode==='utf8')out=Buffer.from([0xff]);
  if(mode==='extra')out+='{}\n';
  if(mode==='wrong-id'||mode==='unknown')out=JSON.stringify(v)+'\n';
  if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,4000));
  process.stdout.write(out);process.exitCode=mode==='nonzero'?1:0;
});
