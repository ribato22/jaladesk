import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{
  const value=JSON.parse(line);
  if(value.type==='connect'){
    process.stderr.write('{"state":"failed","reason":"authentication","lastError":131094}\n');
    setTimeout(()=>{
      const frame=Buffer.from([12,0,0,0,1,0,0,0,1,0,0,0,255,0,0,255]);
      process.stdout.write(frame);
      process.stderr.write('{"state":"connected"}\n');
    },10);
  }else if(value.type==='close')setTimeout(()=>process.exit(1),40);
  else process.exit(17);
});
