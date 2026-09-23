const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function make(options){const scope={URL};vm.createContext(scope);for(const f of ['core.js','cache.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),scope);return scope.SHCache.create(options);}
const result={segments:[{text:'译文',source:[0]}],text:'译文'};
test('LRU bound and expiration',async()=>{
  let clock=1000;const c=make({limit:2,now:()=>clock});await c.ready;
  c.put('a',result);c.put('b',result);c.get('a');c.put('c',result);
  assert.equal(c.get('b'),null);assert.ok(c.get('a'));
  clock+=91*86400000;assert.equal(c.get('a'),null);
});
test('corrupt disk is nonfatal; successful write repairs it',async()=>{
  let saved;const c=make({storage:{read:async()=>{throw new Error('bad json');},write:async d=>saved=d}});
  await c.ready;assert.ok(c.status().error);c.put('a',result);await c.flush();assert.equal(c.status().error,'');assert.equal(saved.entries.length,1);
});
test('serialized clear wins over an earlier write in progress',async()=>{
  let saved,release,first=true;
  const c=make({storage:{read:async()=>null,write:async d=>{if(first){first=false;await new Promise(r=>release=r);}saved=d;}}});
  await c.ready;c.put('a',result);await new Promise(r=>setImmediate(r));const clearing=c.clear();release();await clearing;
  assert.equal(saved.entries.length,0);
});
test('disk write failure leaves working memory cache and clear reports failure',async()=>{
  const c=make({storage:{read:async()=>null,write:async()=>{throw new Error('disk full');}}});
  await c.ready;c.put('a',result);await c.flush();assert.ok(c.get('a'));assert.ok(c.status().error);await assert.rejects(c.clear(),/保存失败/);
});
test('cache restores from a real JSON file after storage and plugin are recreated',async()=>{
  const fsp=require('node:fs/promises');
  const base=path.join(__dirname,'..','work');await fsp.mkdir(base,{recursive:true});
  const dir=await fsp.mkdtemp(path.join(base,'cache-test-'));const file=path.join(dir,'cache.json');
  const storage=()=>({
    read:async()=>{try{return JSON.parse(await fsp.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    write:async d=>{await fsp.writeFile(file+'.tmp',JSON.stringify(d));await fsp.rename(file+'.tmp',file);}
  });
  try{
    const a=make({storage:storage()});await a.ready;const k=a.key('https://example.com/v1/chat/completions','model','Memory.');a.put(k,result);await a.flush();
    const b=make({storage:storage()});await b.ready;assert.equal(b.get(k).text,'译文');await b.flush();
    await b.clear();const c=make({storage:storage()});await c.ready;assert.equal(c.get(k),null);
  }finally{await fsp.unlink(file).catch(()=>{});await fsp.rmdir(dir);}
});
