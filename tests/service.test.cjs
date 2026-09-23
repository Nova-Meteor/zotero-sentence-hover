const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function setup(request) {
  const prefs=new Map(Object.entries({baseURL:'https://example.com/v1',model:'test',apiKey:'private-key'}).map(([k,v])=>['extensions.sentenceHover.'+k,v]));
  const scope={URL, Zotero:{Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},HTTP:{request}},Services:{},Components:{}};
  vm.createContext(scope);
  for(const file of ['core.js','addon.js']) vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'..',file),'utf8'),scope);
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
