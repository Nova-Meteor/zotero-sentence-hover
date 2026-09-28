const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function load() {
  const scope={URL};vm.createContext(scope);
  for(const f of ['core.js','fulltext.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),scope);
  return scope;
}
const page=(...texts)=>({segments:texts.map(text=>({text}))});
const result={text:'睡眠改善记忆。',segments:[{text:'睡眠',source:[0]},{text:'改善记忆。',source:[1,2]}]};
test('all pages are translated once per unique sentence, retaining every word including omissions',async()=>{
  const {SHFullText}=load();const calls=[],snapshots=[];
  const archive=SHFullText.create({id:'A',serviceKey:'svc',storage:{read:async()=>null,write:async d=>snapshots.push(JSON.parse(JSON.stringify(d)))},translate:async text=>{calls.push(text);return result;}});
  const data=[page('Sleep improves memory.','Sleep improves memory.'),page('Research helps memory.')];
  const state=await archive.run({pageCount:2,getPage:async i=>data[i]});
  assert.equal(state.phase,'complete');assert.equal(state.done,2);assert.equal(calls.length,2);
  assert.equal(snapshots.at(-1).pages.length,2);
  const words=archive.get('Sleep improves memory.').words;
  assert.equal(words.length,3);assert.deepEqual([...words[2].targetSegments],[1]);
  const omitted=SHFullText.aligned('The memory.',{text:'记忆。',segments:[{text:'记忆。',source:[1]}]});
  assert.equal(omitted.words[0].status,'unmapped');assert.deepEqual([...omitted.words[0].targetSegments],[]);
});
test('parallel workers respect limit, handle out-of-order responses and do not duplicate sentences',async()=>{
  const {SHFullText}=load();let active=0,peak=0;const waiting=new Map(),calls=[];
  const a=SHFullText.create({id:'A',serviceKey:'svc',translate:async text=>{
    calls.push(text);active++;peak=Math.max(peak,active);
    await new Promise(r=>waiting.set(text,()=>{active--;waiting.delete(text);r();}));
    return {text:'译文 '+text,segments:[{text:'译文 '+text,source:[0]}]};
  }});
  const texts=Array.from({length:7},(_,i)=>'Sentence '+i+'.');
  const task=a.run({pageCount:1,concurrency:3,getPage:async()=>page(...texts,texts[0])});
  await new Promise(r=>setImmediate(r));assert.equal(calls.length,3);assert.equal(active,3);
  waiting.get(texts[2])();await new Promise(r=>setImmediate(r));
  assert.ok(a.get(texts[2]));assert.equal(a.get(texts[0]),null);assert.equal(calls.length,4);
  while(waiting.size){[...waiting.values()].reverse().forEach(r=>r());await new Promise(r=>setImmediate(r));}
  const state=await task;assert.equal(peak,3);assert.equal(state.phase,'complete');assert.equal(state.done,7);
  assert.equal(new Set(calls).size,7);assert.equal(calls.length,7);
  for(const text of texts)assert.equal(a.get(text).text,'译文 '+text);
});
test('parallel cancellation aborts all active work, starts no queued sentences and resumes missing ones',async()=>{
  const {SHFullText}=load();let calls=0,cancelled=0;const waits=[];
  let hold=true;
  const a=SHFullText.create({id:'A',serviceKey:'svc',translate:async(text,s)=>{
    calls++;
    if(hold)await new Promise((resolve,reject)=>{waits.push(resolve);s.onCancel(()=>{cancelled++;reject(new Error('cancel'));});});
    return result;
  }});
  const args={pageCount:1,concurrency:3,getPage:async()=>page(...Array.from({length:8},(_,i)=>'Sleep improves memory '+i+'.'))};
  const task=a.run(args);await new Promise(r=>setImmediate(r));
  assert.equal(calls,3);a.cancel();assert.equal((await task).phase,'cancelled');assert.equal(cancelled,3);
  assert.equal(a.snapshot().results.length,0);
  waits.forEach(r=>r());hold=false;
  assert.equal((await a.run(args)).phase,'complete');assert.equal(calls,11);
});
test('rate limit stops new dispatches while preserving successful in-flight sentences',async()=>{
  const {SHFullText}=load();let calls=0;const waits=[];
  const a=SHFullText.create({id:'A',serviceKey:'svc',translate:async text=>{
    calls++;await new Promise(r=>waits.push(r));
    if(text==='Sentence 0.')throw new Error('API 请求受限或余额不足');
    return {text:'译文',segments:[{text:'译文',source:[0]}]};
  }});
  const task=a.run({pageCount:1,concurrency:3,getPage:async()=>page(...Array.from({length:9},(_,i)=>'Sentence '+i+'.'))});
  await new Promise(r=>setImmediate(r));assert.equal(calls,3);
  waits[0]();await new Promise(r=>setImmediate(r));waits.slice(1).forEach(r=>r());
  const s=await task;assert.equal(calls,3);assert.equal(s.phase,'partial');assert.equal(s.done,2);assert.equal(s.failed,1);
});
test('cancel stops requests and continuation reuses completed results',async()=>{
  const {SHFullText}=load();let archive,calls=0;
  archive=SHFullText.create({id:'A',serviceKey:'svc',translate:async()=>{calls++;return result;}});
  const unsubscribe=archive.subscribe(s=>{if(s.phase==='translating'&&s.done===1)archive.cancel();});
  const args={pageCount:1,concurrency:1,getPage:async()=>page('Sleep improves memory.','Research helps memory.')};
  assert.equal((await archive.run(args)).phase,'cancelled');assert.equal(calls,1);
  unsubscribe();assert.equal((await archive.run(args)).phase,'complete');assert.equal(calls,2);
});
test('cancel interrupts a pending provider call and never counts its late result',async()=>{
  const {SHFullText}=load();let finish,started;
  const ready=new Promise(r=>started=r);
  const archive=SHFullText.create({id:'A',serviceKey:'svc',translate:async()=>{started();await new Promise(r=>finish=r);return result;}});
  const task=archive.run({pageCount:1,getPage:async()=>page('Sleep improves memory.')});
  await ready;archive.cancel();assert.equal((await task).phase,'cancelled');
  finish();await new Promise(r=>setImmediate(r));assert.equal(archive.get('Sleep improves memory.'),null);
});
test('double start shares one job and clear waits for cancellation without restoring results',async()=>{
  const {SHFullText}=load();let started,finish,calls=0,saved;
  const requestStarted=new Promise(r=>started=r);
  const a=SHFullText.create({id:'A',serviceKey:'svc',storage:{read:async()=>null,write:async d=>saved=JSON.parse(JSON.stringify(d))},translate:async()=>{calls++;started();await new Promise(r=>finish=r);return result;}});
  const args={pageCount:1,getPage:async()=>page('Sleep improves memory.')};
  const first=a.run(args),second=a.run(args);await requestStarted;
  await a.clear();assert.equal(saved.results.length,0);assert.equal(calls,1);
  finish();await Promise.all([first,second]);await new Promise(r=>setImmediate(r));
  assert.equal(a.get('Sleep improves memory.'),null);assert.equal(saved.results.length,0);
});
test('persisted full document restores more than the ordinary 1000-sentence cache limit',async()=>{
  const {SHFullText}=load();let data,calls=0;
  const storage={read:async()=>data?JSON.parse(data):null,write:async d=>data=JSON.stringify(d)};
  const entries=Array.from({length:1005},(_,i)=>'Sleep improves memory '+i+'.');
  const a=SHFullText.create({id:'A',serviceKey:'svc',storage,translate:async()=>{calls++;return result;}});
  await a.run({pageCount:1,getPage:async()=>page(...entries)});
  const b=SHFullText.create({id:'A',serviceKey:'svc',storage,translate:async()=>{throw new Error('must not call');}});
  await b.ready;assert.ok(b.get(entries[0]));assert.ok(b.get(entries[1004]));
  assert.equal(b.get(entries[0]).words.length,3);assert.equal(calls,1005);
  assert.equal((await b.run({pageCount:1,getPage:async()=>page(...entries)})).phase,'complete');
});
test('failed or textless pages are not reported as complete and failures can retry',async()=>{
  const {SHFullText}=load();let fail=true;
  const archive=SHFullText.create({id:'A',serviceKey:'svc',translate:async()=>{if(fail)throw new Error('API 认证失败');return result;}});
  const args={pageCount:3,getPage:async i=>{if(i===2)throw new Error('page failed');return i===1?page():page('Sleep improves memory.');}};
  const s=await archive.run(args);assert.equal(s.phase,'partial');assert.equal(s.emptyPages,1);assert.equal(s.failed,1);assert.deepEqual([...archive.snapshot().pageErrors],[3]);
  fail=false;assert.equal((await archive.run({pageCount:1,getPage:async()=>page('Sleep improves memory.')})).phase,'complete');
});
test('a temporarily unreadable page does not delete its already translated sentences',async()=>{
  const {SHFullText}=load();let calls=0;
  const a=SHFullText.create({id:'A',serviceKey:'svc',translate:async()=>{calls++;return result;}});
  const pages=[page('Sleep improves memory.'),page('Research helps memory.')];
  await a.run({pageCount:2,getPage:async i=>pages[i]});
  const s=await a.run({pageCount:2,getPage:async i=>{if(i===1)throw new Error('temporarily unavailable');return pages[i];}});
  assert.equal(s.phase,'partial');assert.ok(a.get('Research helps memory.'));
  await a.run({pageCount:2,getPage:async i=>pages[i]});assert.equal(calls,2);
});
test('disk failure is explicit; clear deletes results and retry can recover',async()=>{
  const {SHFullText}=load();let fail=true,saved;
  const archive=SHFullText.create({id:'A',serviceKey:'svc',storage:{read:async()=>null,write:async d=>{if(fail)throw new Error('disk full');saved=d;}},translate:async()=>result});
  const args={pageCount:1,getPage:async()=>page('Sleep improves memory.')};
  assert.equal((await archive.run(args)).phase,'error');
  fail=false;assert.equal((await archive.run(args)).phase,'complete');assert.equal(saved.results.length,1);
  await archive.clear();assert.equal(saved.results.length,0);assert.equal(archive.get('Sleep improves memory.'),null);
});
test('large sentences split consistently without losing English tokens',()=>{
  const {SHCore}=load();const text=('Memory improves learning; ').repeat(160);
  const chars=Array.from(text,(c,i)=>({c,rect:[i,0,i+1,10]}));
  const data=SHCore.buildPage(chars);
  assert.ok(data.segments.length>1);
  assert.ok(data.segments.every(s=>s.text.length<=1800));
  assert.equal(data.segments.flatMap(s=>SHCore.words(s.text)).length,SHCore.words(text).length);
  for(const s of data.segments)assert.equal(data.text.slice(s.start,s.end),s.text);
});
