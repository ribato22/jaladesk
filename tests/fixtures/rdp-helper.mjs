import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
function frame(){const p=Buffer.alloc(20);p.writeUInt32LE(16);p.writeUInt32LE(2,4);p.writeUInt32LE(1,8);p.set([255,0,0,255,0,255,0,255],12);process.stdout.write(p);}
rl.on('line',line=>{
  const v=JSON.parse(line);
  if(v.type==='connect') {
    if(v.target.host==='crash.invalid'){process.exit(5);}
    if(v.target.host==='leak.invalid'){process.stderr.write(JSON.stringify({state:'failed',reason:v.secret.password})+'\n');return;}
    process.stderr.write('{"state":"connected"}\n');frame();
  }
  if(v.type==='close'){frame();setTimeout(()=>process.exit(0),20);}
});
