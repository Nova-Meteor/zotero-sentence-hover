const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require(process.env.SH_JSDOM || 'jsdom');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(request, pageTop = 0, geometry = 'normal', pageLeft = 0) {
  const dom=new JSDOM('<body><div class="page" data-page-number="1"></div></body>',{pretendToBeVisual:true});
  const win=dom.window,doc=win.document,page=doc.querySelector('.page');
  for (const [key,value] of Object.entries({offsetWidth:600,offsetHeight:800,clientWidth:600,clientHeight:800,clientLeft:0,clientTop:0})) Object.defineProperty(page,key,{value});
  page.getBoundingClientRect=()=>({left:pageLeft,top:pageTop,width:600,height:800});
  doc.elementFromPoint=(x,y)=>x<pageLeft+500&&y<pageTop+100?page:doc.body;
  const text='Sleep improves memory. Research helps.';
  const chars=Array.from(text,(c,i)=>({c,rect:[i*8,10,i*8+8,24]}));
  const viewport = {
    width:600,height:800,convertToPdfPoint:(x,y)=>[x,y],
    convertToViewportRectangle:()=>{throw new Error('Permission denied to access property 0');},
    convertToViewportPoint:(x,y)=>{
      assert.equal(typeof x,'number');assert.equal(typeof y,'number');
      if(geometry==='throws')throw new Error('Reader geometry unavailable');
      if(geometry==='invalid')return [NaN,Infinity];
      if(geometry==='oversize')return [x,y===10?-400:900];
      return [x,y];
    }
  };
  win.PDFViewerApplication={pdfDocument:{getPageData:async()=>({chars})},pdfViewer:{getPageView:()=>({viewport})}};
  const prefs=new Map(Object.entries({baseURL:'https://example.com/v1',model:'test',delay:200,enabled:true}).map(([k,v])=>['extensions.sentenceHover.'+k,v]));
  const scope={URL,Zotero:{Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},HTTP:{request},getMainWindow:()=>win,Reader:{_readers:[{_iframeWindow:win}]}},Services:{},Components:{utils:{cloneInto:x=>x}}};
  vm.createContext(scope);
  for(const file of ['core.js','addon.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),scope);
  const api=scope.SentenceHover;api.start();
  doc.getElementById('sentence-hover-popup').getBoundingClientRect=()=>({width:480,height:120});
  return {api,win,doc,move:(x)=>page.dispatchEvent(new win.MouseEvent('mousemove',{bubbles:true,clientX:pageLeft+x,clientY:pageTop+16})),close:()=>{api.stop();win.close();}};
}
const answer={response:{choices:[{message:{content:JSON.stringify({segments:[{text:'睡眠',source:[0]},{text:'改善',source:[1]},{text:'记忆。',source:[2]}]})}}]}};
test('hover whole sentence, move word highlights, no extra request, cleanup',async()=>{
  let count=0;const f=fixture(async()=>{count++;return answer;});
  try{
    assert.equal(f.api.diagnostic().connectedPDFViews,1);
    f.move(12);await wait(280);
    const box=f.doc.getElementById('sentence-hover-popup');
    assert.equal(box.style.display,'block');assert.ok(box.textContent.includes('睡眠改善记忆。'));
    const lit=()=>[...box.querySelectorAll('span')].filter(s=>s.style.background).map(s=>s.textContent);
    assert.deepEqual(lit(),['睡眠']);
    f.move(64);await wait(80);assert.deepEqual(lit(),['改善']);assert.equal(count,1);
    f.doc.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(box.style.display,'none');
    f.api.stop();assert.equal(f.doc.getElementById('sentence-hover-popup'),null);
  } finally {f.close();}
});
test('late API response cannot reopen a dismissed popup',async()=>{
  let finish;const f=fixture(async()=>{await new Promise(r=>finish=r);return answer;});
  try{f.move(12);await wait(260);f.doc.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'Escape'}));finish();await wait(40);assert.equal(f.doc.getElementById('sentence-hover-popup').style.display,'none');}finally{f.close();}
});
test('scroll cancels pending hover before sending text',async()=>{
  let count=0;const f=fixture(async()=>{count++;return answer;});
  try{f.move(12);await wait(70);f.doc.dispatchEvent(new f.win.Event('scroll'));await wait(250);assert.equal(count,0);}finally{f.close();}
});
test('popup centers above sentence and remains anchored when hovering another word',async()=>{
  const f=fixture(async()=>answer,300,'normal',300);
  try{
    f.move(12);await wait(280);
    const box=f.doc.getElementById('sentence-hover-popup');
    assert.equal(box.style.top,'180px');
    assert.equal(box.style.left,'148px');
    f.move(64);await wait(80);
    assert.equal(box.style.top,'180px');assert.equal(box.style.left,'148px');
  }finally{f.close();}
});
test('sentence near top of viewport places popup below without covering it',async()=>{
  const f=fixture(async()=>answer);
  try{
    f.move(12);await wait(280);
    assert.equal(f.doc.getElementById('sentence-hover-popup').style.top,'34px');
  }finally{f.close();}
});
for(const geometry of ['throws','invalid','oversize']) {
  test('geometry '+geometry+' keeps translation visible with readable height',async()=>{
    let count=0;const f=fixture(async()=>{count++;return answer;},300,geometry);
    try{
      f.move(12);await wait(280);
      const box=f.doc.getElementById('sentence-hover-popup');
      assert.equal(box.style.display,'block');assert.equal(count,1);
      assert.ok(box.textContent.includes('睡眠改善记忆。'));
      assert.ok(Number.parseFloat(box.style.maxHeight)>=60);
      assert.ok(Number.parseFloat(box.style.top)>=12);
      assert.ok(Number.parseFloat(box.style.top)+120<=f.win.innerHeight);
    }finally{f.close();}
  });
}
