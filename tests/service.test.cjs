const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function setup(request, extra = {}) {
  const prefs=new Map(Object.entries({baseURL:'https://example.com/v1',model:'test',apiKey:'private-key'}).map(([k,v])=>['extensions.sentenceHover.'+k,v]));
  const scope={URL, Zotero:{Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},HTTP:{request},Reader:{_readers:[]},Profile:{dir:'/profile'}},Services:{},Components:{},...extra};
  vm.createContext(scope);
  for(const file of ['core.js','cache.js','addon.js']) vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'..',file),'utf8'),scope);
  return scope.SentenceHover;
}
const response={response:{choices:[{message:{content:JSON.stringify({segments:[{text:'记忆',source:[0]}]})}}]}};
test('same sentence coalesces requests and uses cache',async()=>{
  let calls=0, finish;
  const api=setup(async(method,url,options)=>{calls++;assert.equal(method,'POST');assert.equal(options.headers.Authorization,'Bearer private-key');const body=JSON.parse(options.body);assert.equal(body.messages.length,2);await new Promise(r=>finish=r);return response;});
  const a=api.translate('Memory improves.'),b=api.translate('Memory improves.');
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);finish();
  assert.equal((await a).text,'记忆');await b;await api.translate('Memory improves.');assert.equal(calls,1);
});
test('failed requests are not cached and HTTP errors hide server contents',async()=>{
  let calls=0;const api=setup(async()=>{calls++;if(calls===1)throw{status:401,message:'private-key'};return response;});
  await assert.rejects(api.translate('Memory.'),e=>!e.message.includes('private-key')&&e.message.includes('认证'));
  assert.equal((await api.translate('Memory.')).text,'记忆');assert.equal(calls,2);
});
test('changing configuration invalidates cached translations',async()=>{
  let calls=0;const api=setup(async()=>{calls++;return response;});
  await api.translate('Memory.');api.save({...api.config(),model:'new-model'});await api.translate('Memory.');assert.equal(calls,2);
});
test('at most two distinct requests may run concurrently',async()=>{
  const finishes=[];const api=setup(async()=>{await new Promise(r=>finishes.push(r));return response;});
  const a=api.translate('Memory.'),b=api.translate('Sleep.');
  await assert.rejects(api.translate('Research.'),/正在处理/);
  await new Promise(r=>setImmediate(r));finishes.forEach(f=>f());await Promise.all([a,b]);
});
test('disk cache survives new plugin instance; force refresh replaces it without storing credentials',async()=>{
  let disk=null,calls=0;
  const reader={_item:{getFilePathAsync:async()=>'/storage/DRMTBZNF/paper.pdf'}};
  const extra={PathUtils:{join:(...a)=>a.join('/'),parent:p=>p.slice(0,p.lastIndexOf('/'))},IOUtils:{exists:async p=>p.endsWith('.pdf')||disk!==null,stat:async()=>({size:disk.length}),readJSON:async()=>JSON.parse(disk),writeJSON:async(p,data,options)=>{assert.equal(p,'/storage/DRMTBZNF/sentence-hover-cache.json');assert.equal(options.tmpPath,p+'.tmp');disk=JSON.stringify(data);}}};
  const request=async()=>{calls++;return response;};
  const a=setup(request,extra);await a.translate('Memory.',{reader});await a.flushCache();
  assert.ok(disk.includes('Memory.'));assert.ok(!disk.includes('private-key'));
  const b=setup(request,extra);await b.translate('Memory.',{reader});assert.equal(calls,1);
  await b.translate('Memory.',{force:true,reader});assert.equal(calls,2);
  await b.reset();assert.equal(JSON.parse(disk).entries.length,0);
  const c=setup(request,extra);await c.translate('Memory.',{reader});assert.equal(calls,3);
});
test('article directories are isolated; settings test never writes an article cache',async()=>{
  const disk=new Map();let calls=0;
  const extra={PathUtils:{join:(...a)=>a.join('/'),parent:p=>p.slice(0,p.lastIndexOf('/'))},IOUtils:{exists:async p=>p.endsWith('.pdf')||disk.has(p),stat:async p=>({size:disk.get(p).length}),readJSON:async p=>JSON.parse(disk.get(p)),writeJSON:async(p,d)=>disk.set(p,JSON.stringify(d))}};
  const a={_item:{getFilePathAsync:async()=>'/storage/AAAA/paper.pdf'}},b={_item:{getFilePathAsync:async()=>'/storage/BBBB/paper.pdf'}};
  const api=setup(async()=>{calls++;return response;},extra);
  await api.translate('Memory.',{reader:a});await api.translate('Memory.',{reader:b});await api.flushCache();
  assert.equal(calls,2);assert.equal(disk.size,2);
  await api.translate('Memory.',{reader:a});assert.equal(calls,2);
  await api.translate('Settings example.');await api.flushCache();assert.equal(disk.size,2);
  const missing={_item:{getFilePathAsync:async()=>false}};
  await api.translate('Missing.',{reader:missing});await api.flushCache();assert.equal(disk.size,2);
  assert.ok(api.diagnostic().cache.error.includes('尚未'));
});
test('saving timing settings retains cache and switching models isolates then restores it',async()=>{
  let calls=0;const api=setup(async()=>{calls++;return response;});
  await api.translate('Memory.');api.save({...api.config(),delay:700});await api.translate('Memory.');assert.equal(calls,1);
  api.save({...api.config(),model:'another'});await api.translate('Memory.');assert.equal(calls,2);
  api.save({...api.config(),model:'test'});await api.translate('Memory.');assert.equal(calls,2);
});
test('failed force refresh preserves previous result and repeated refresh coalesces',async()=>{
  let calls=0,finish;
  const api=setup(async()=>{calls++;if(calls>1){await new Promise(r=>finish=r);throw{status:429};}return response;});
  await api.translate('Memory.');
  const a=api.translate('Memory.',{force:true}),b=api.translate('Memory.',{force:true});
  const rejected=Promise.all([assert.rejects(a),assert.rejects(b)]);
  await new Promise(r=>setImmediate(r));finish();await rejected;
  await api.translate('Memory.');assert.equal(calls,2);
});
test('clearing cache prevents late response from repopulating it',async()=>{
  let finish,calls=0;const api=setup(async()=>{calls++;if(calls===1)await new Promise(r=>finish=r);return response;});
  const old=api.translate('Memory.');await new Promise(r=>setImmediate(r));await api.reset();finish();await old;
  await api.translate('Memory.');assert.equal(calls,2);
});
