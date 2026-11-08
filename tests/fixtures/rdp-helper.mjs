import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
let host='';
function frame(w=2,h=1){
  const p=Buffer.alloc(12+w*h*4);p.writeUInt32LE(8+w*h*4);p.writeUInt32LE(w,4);p.writeUInt32LE(h,8);
  for(let i=0;i<w*h;i++)p.set(i%2?[0,255,0,255]:[255,0,0,255],12+i*4);process.stdout.write(p);
}
const event=value=>process.stderr.write(JSON.stringify(value)+'\n');
const b64=(text,fill)=>(fill?Buffer.alloc(text,97):Buffer.from(text)).toString('base64');
rl.on('line',line=>{
  const v=JSON.parse(line);
  if(v.type==='connect') {
    host=v.target.host;
    if(host==='crash.invalid'){process.exit(5);}
    if(host==='leak.invalid'){process.stderr.write(JSON.stringify({state:'failed',reason:v.secret.password,lastError:0x00020008})+'\n');return;}
    const diagnostics={'code.invalid':0x00020008,'zero.invalid':0,'maximum.invalid':0xffffffff,'string-code.invalid':v.secret.password,'negative-code.invalid':-1,'fractional-code.invalid':1.5,'overflow-code.invalid':0x100000000,'null-code.invalid':null};
    if(Object.hasOwn(diagnostics,host)){process.stderr.write(JSON.stringify({state:'failed',reason:'connection',lastError:diagnostics[host]})+'\n');return;}
    if(host==='old-failure.invalid'){process.stderr.write('{"state":"failed","reason":"connection"}\n');return;}
    if(host==='connected-code.invalid'){process.stderr.write('{"state":"connected","lastError":131080}\n');return;}
    process.stderr.write('{"state":"connected"}\n');frame();
    // The server ended the session: the helper reports "closed" (with the reason it read, when it read one) and exits.
    const serverEnds={'server-closed.invalid':{},'other-connection.invalid':{reason:'other-connection',lastError:5},'logoff.invalid':{reason:'logoff',lastError:12},
      'unknown-reason.invalid':{reason:v.secret.password,lastError:5},'closed-bad-code.invalid':{reason:'logoff',lastError:-1},'stubborn.invalid':{}};
    // stubborn.invalid says goodbye but ignores SIGTERM and lingers until it is closed, so the owner's close arrives while the helper is still alive.
    if(host==='stubborn.invalid')process.on('SIGTERM',()=>{});
    if(Object.hasOwn(serverEnds,host)){setTimeout(()=>{event({state:'closed',...serverEnds[host]});if(host!=='stubborn.invalid')setTimeout(()=>process.exit(0),20);},40);return;}
    if(host==='clip-remote.invalid')event({event:'clipboard',b64:b64('halo dari remote 😀')});
    if(host==='clip-bad.invalid')event({event:'clipboard',b64:'@@@@'});
    if(host==='clip-big.invalid')event({event:'clipboard',b64:b64(32*1024+1,true)});
    if(host==='event-unknown.invalid')event({event:'surprise'});
    if(host==='long-line.invalid')process.stderr.write('x'.repeat(70000));
    if(host==='clip-burst.invalid'){
      // Two maximum-size lines whose chunks overlap: the buffered tail briefly exceeds one line's limit.
      const one=JSON.stringify({event:'clipboard',b64:b64(32*1024,true)})+'\n';
      process.stderr.write(one.slice(0,40000));
      setTimeout(()=>process.stderr.write(one.slice(40000)+one.slice(0,25000)),30);
      setTimeout(()=>process.stderr.write(one.slice(25000)),60);
    }
    return;
  }
  if(v.type==='resize')frame(v.width,v.height);
  if(v.type==='clipboard'&&host==='clip-echo.invalid')event({event:'clipboard',b64:v.b64});
  if(v.type==='close'){
    if(host==='clip-late.invalid')event({event:'clipboard',b64:b64('zombi')});   // a helper that talks while it is being closed
    frame();setTimeout(()=>process.exit(0),20);
  }
});
