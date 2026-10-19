import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('receiver enforces signature, timestamp, size, exact path and queue limit', async()=>{
  const directory=mkdtempSync(join(tmpdir(),'spooktober-hook-test-'));
  const secret='isolated-test-fixture-signing-key-only';
  for(const sub of ['tmp','requests']) mkdirSync(join(directory,sub));
  writeFileSync(join(directory,'secret'),secret,{mode:0o600});
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],
    {env:{...process.env,WEBHOOK_SECRET_FILE:join(directory,'secret'),SPOOL_DIR:directory,PORT:'19000'},stdio:['ignore','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Receiver failed to listen')),5000);
      child.stdout.on('data',d=>{if(d.toString().includes('listening')){clearTimeout(timer);resolve();}});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Receiver exited'));});
    });
    const value={digest:'sha256:'+'a'.repeat(64),revision:'b'.repeat(40),timestamp:Math.floor(Date.now()/1000)};
    const send=async(body,signature,path='/hooks/spooktober')=>fetch('http://127.0.0.1:19000'+path,
      {method:'POST',body,headers:{'X-Spooktober-Signature':signature}});
    const signed=body=>'sha256='+createHmac('sha256',secret).update(body).digest('hex');
    const body=JSON.stringify(value);
    const denied=await send(body,'sha256=wrong');
    assert.equal(denied.status,401);
    assert.equal(denied.headers.get('X-Spooktober-Deploy-Hook'),'1');
    assert.equal(readdirSync(join(directory,'requests')).length,0);
    for(const invalid of [{...value,timestamp:value.timestamp-600},{...value,digest:'invalid'},{...value,revision:'invalid'}]){
      const data=JSON.stringify(invalid);assert.equal((await send(data,signed(data))).status,400);
    }
    assert.equal((await send('broken',signed('broken'))).status,400);
    assert.equal((await send('x'.repeat(1025),'invalid')).status,413);
    for(const path of ['/','/other','/hooks/spooktober?x=1'])assert.equal((await send(body,signed(body),path)).status,404);
    assert.equal((await fetch('http://127.0.0.1:19000/healthz')).status,200);
    assert.equal((await send(body,signed(body))).status,202);
    assert.equal(readdirSync(join(directory,'requests')).length,1);
    assert.equal(readdirSync(join(directory,'tmp')).length,0);
    for(let i=0;i<63;i++)writeFileSync(join(directory,'requests',`fixture-${i}.json`),'{}');
    assert.equal((await send(body,signed(body))).status,503);
    assert.equal(readdirSync(join(directory,'requests')).length,64);
  }finally{
    child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(directory,{recursive:true,force:true});
  }
});

test('status endpoint is signed, scoped to one release and exposes only sanitized fields',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'spooktober-status-test-'));
  const secret='isolated-test-fixture-signing-key-only';
  for(const sub of ['requests','status']) mkdirSync(join(directory,sub));
  writeFileSync(join(directory,'secret'),secret,{mode:0o600});
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],
    {env:{...process.env,WEBHOOK_SECRET_FILE:join(directory,'secret'),SPOOL_DIR:directory,PORT:'19001'},stdio:['ignore','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Receiver failed to listen')),5000);
      child.stdout.on('data',d=>{if(d.toString().includes('listening')){clearTimeout(timer);resolve();}});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Receiver exited'));});
    });
    const digest='sha256:'+'a'.repeat(64),revision='b'.repeat(40);
    const sign=(text)=>'sha256='+createHmac('sha256',secret).update(text).digest('hex');
    const now=()=>Math.floor(Date.now()/1000);
    const ask=async({d=digest,r=revision,timestamp=now(),signature,extra=''}={})=>{
      const sig=signature??sign(`status\n${d}\n${r}\n${timestamp}`);
      return fetch(`http://127.0.0.1:19001/hooks/spooktober?digest=${d}&revision=${r}&timestamp=${timestamp}${extra}`,{headers:{'X-Spooktober-Signature':sig}});
    };
    const file=join(directory,'status',`${revision}-${'a'.repeat(64)}.json`);

    // Missing record: pending, not an error, and never another release's data.
    let response=await ask();
    assert.equal(response.status,200);
    assert.equal(response.headers.get('X-Spooktober-Deploy-Hook'),'1');
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(await response.json(),{digest,revision,status:'pending'});

    // Only whitelisted fields leave the host, whatever the file contains.
    writeFileSync(file,JSON.stringify({digest,revision,status:'failed',phase:'migrate',rollback:'restored',requested:123,updated_at:'2026-10-19T13:33:38+00:00',
      error:'postgres://user:password@private/db',log:'secret'}));
    response=await ask();
    const body=await response.text();
    assert.deepEqual(JSON.parse(body),{digest,revision,status:'failed',phase:'migrate',rollback:'restored',requested:123,updated_at:'2026-10-19T13:33:38+00:00'});
    assert.ok(!body.includes('password')&&!body.includes('secret'));

    // Unknown values, another release's record, oversized and symlinked files read as pending.
    for(const bad of [{status:'weird',phase:'migrate'},{status:'failed',phase:'/etc/passwd'},{digest:'sha256:'+'c'.repeat(64),status:'succeeded',phase:'complete'},{revision:'d'.repeat(40),status:'succeeded',phase:'complete'}]){
      writeFileSync(file,JSON.stringify({digest,revision,status:'succeeded',phase:'complete',...bad}));
      assert.equal((await (await ask()).json()).status,'pending');
    }
    writeFileSync(file,JSON.stringify({digest,revision,status:'succeeded',phase:'complete',pad:'x'.repeat(2000)}));
    assert.equal((await (await ask()).json()).status,'pending');
    rmSync(file);
    const outside=join(directory,'outside.json');
    writeFileSync(outside,JSON.stringify({digest,revision,status:'succeeded',phase:'complete'}));
    symlinkSync(outside,file);
    assert.equal((await (await ask()).json()).status,'pending');
    rmSync(file);

    // Authentication: bad, missing, replayed deploy signatures and stale or malformed queries.
    assert.equal((await ask({signature:'sha256=wrong'})).status,401);
    assert.equal((await ask({signature:''})).status,401);
    const timestamp=now();
    const deployBody=JSON.stringify({digest,revision,timestamp});
    assert.equal((await ask({timestamp,signature:sign(deployBody)})).status,401);
    assert.equal((await ask({timestamp,signature:sign(`${digest}\n${revision}\n${timestamp}`)})).status,401);
    const stale=now()-600;
    assert.equal((await ask({timestamp:stale})).status,400);
    assert.equal((await ask({d:'invalid'})).status,400);
    assert.equal((await ask({extra:'&path=../../etc'})).status,400);
    assert.equal((await ask({extra:`&digest=${digest}`})).status,400);
    // A signature for one release cannot be used to read another.
    const other='sha256:'+'c'.repeat(64);
    assert.equal((await ask({d:other,signature:sign(`status\n${digest}\n${revision}\n${timestamp}`),timestamp})).status,401);
    // Status requests never queue deployments.
    assert.equal(readdirSync(join(directory,'requests')).length,0);
    assert.equal((await fetch('http://127.0.0.1:19001/hooks/spooktober')).status,404);
    assert.equal((await fetch('http://127.0.0.1:19001/other?digest=x')).status,404);
  }finally{
    child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(directory,{recursive:true,force:true});
  }
});
