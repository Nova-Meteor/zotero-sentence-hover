const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');
test('academic abbreviations, decimals, paragraphs and sentence endings', () => {
  const text = 'Dr. Smith et al. report 3.14 in Fig. 2. This works!\nNext paragraph.';
  assert.deepEqual(core.sentences(text).map(s=>s.text), ['Dr. Smith et al. report 3.14 in Fig. 2.', 'This works!', 'Next paragraph.']);
  for (const s of core.sentences(text)) assert.equal(text.slice(s.start,s.end),s.text);
});
test('word identity preserves repeated words and contractions', () => {
  const w = core.words("Memory improves memory; it doesn't erase it.");
  assert.deepEqual(w.map(x=>x.text), ['Memory','improves','memory','it',"doesn't",'erase','it']);
  assert.notEqual(w[0].id,w[2].id);
});
test('reordered many-to-many mappings preserve the exact Chinese sentence', () => {
  const r = core.parseResult(JSON.stringify({segments:[{text:'睡眠',source:[4]},{text:'能改善',source:[5]},{text:'记忆。',source:[6]}]}),7);
  assert.equal(r.text,'睡眠能改善记忆。');
  assert.deepEqual(r.segments.filter(s=>s.source.includes(4)).map(s=>s.text),['睡眠']);
  assert.deepEqual(r.segments.filter(s=>s.source.includes(0)),[]);
});
test('reject corrupt token references; retain HTML as text', () => {
  assert.throws(()=>core.parseResult('{"segments":[{"text":"词","source":[9]}]}',2));
  assert.throws(()=>core.parseResult('{"segments":[{"text":"词","source":["1"]}]}',2));
  assert.throws(()=>core.parseResult('{}',2));
  const r = core.parseResult('```json\n{"segments":[{"text":"<img onerror=x>","source":[]}]}\n```',2);
  assert.equal(r.text,'<img onerror=x>');
});
test('PDF line-end hyphen repair and geometry hit testing', () => {
  const chars = [];
  const add=(c,x,y,extra={})=>chars.push({c,rect:[x,y,x+8,y+12],...extra});
  Array.from('Mem-').forEach((c,i)=>add(c,i*8,30,i===3?{lineBreakAfter:true}:{}));
  Array.from('ory improves.').forEach((c,i)=>add(c,i*8,10));
  const p = core.buildPage(chars);
  assert.equal(p.text,'Memory improves.');
  assert.equal(core.atPoint(p,4,15).word.text,'Memory');
  assert.equal(core.atPoint(p,50,15).word.text,'improves');
  assert.equal(core.atPoint(p,400,200),null);
});
test('endpoint normalization and remote HTTP rejection', () => {
  assert.equal(core.endpoint('https://example.com/v1/'),'https://example.com/v1/chat/completions');
  assert.equal(core.endpoint('http://127.0.0.1:1234/v1/chat/completions'),'http://127.0.0.1:1234/v1/chat/completions');
  assert.throws(()=>core.endpoint('http://example.com/v1'));
  assert.throws(()=>core.endpoint('https://user:secret@example.com/v1'));
});
test('sentence area includes unrendered word gaps but excludes margins and column gutters',()=>{
  const chars=[];
  for(const [text,x] of [['Sleep',0],['improves',55],['memory.',300]]){
    Array.from(text).forEach((c,i)=>chars.push({c,rect:[x+i*8,10,x+i*8+8,24],spaceAfter:i===text.length-1}));
  }
  const p=core.buildPage(chars),s=p.segments[0];
  assert.equal(core.atPoint(p,48,16),null);
  assert.equal(core.withinSentence(p,s,48,16),true);
  assert.equal(core.withinSentence(p,s,200,16),false);
  assert.equal(core.withinSentence(p,s,20,40),false);
  assert.equal(core.withinSentence(p,s,-5,16),false);
});
test('wrapped sentence includes interline space but not paragraph gaps or separate columns',()=>{
  const make=(x,y)=>core.buildPage([
    {c:'Sleep improves ',rect:[0,10,120,24]},
    {c:'memory.',rect:[x,y,x+56,y+14]}
  ]);
  let p=make(0,34);
  assert.equal(core.withinSentence(p,p.segments[0],90,29),true);
  assert.equal(core.withinSentence(p,p.segments[0],140,29),false);
  assert.equal(core.withinSentence(p,p.segments[0],20,55),false);
  p=make(0,90);assert.equal(core.withinSentence(p,p.segments[0],20,50),false);
  p=make(300,34);assert.equal(core.withinSentence(p,p.segments[0],200,29),false);
});
