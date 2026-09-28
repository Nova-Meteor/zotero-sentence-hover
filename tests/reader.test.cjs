const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require(process.env.SH_JSDOM || 'jsdom');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(request, pageTop = 0, geometry = 'normal', pageLeft = 0, multiline = false, fullSetup = null) {
  const dom=new JSDOM('<body><div class="page" data-page-number="1"></div></body>',{pretendToBeVisual:true});
  const win=dom.window,doc=win.document,page=doc.querySelector('.page');
  const host=new JSDOM('<body></body>',{pretendToBeVisual:true}).window;
  for (const [key,value] of Object.entries({offsetWidth:600,offsetHeight:800,clientWidth:600,clientHeight:800,clientLeft:0,clientTop:0})) Object.defineProperty(page,key,{value});
  page.getBoundingClientRect=()=>({left:pageLeft,top:pageTop,width:600,height:800});
  doc.elementFromPoint=(x,y)=>x<pageLeft+500&&y<pageTop+100?page:doc.body;
  const text='Sleep improves memory. Research helps.';
  const chars=Array.from(text,(c,i)=>{
    const secondLine=multiline && i>=15;
    const x=(secondLine?i-15:i)*8,y=secondLine?34:10;
    return {c,rect:[x,y,x+8,y+14]};
  });
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
  const prefs=new Map(Object.entries({baseURL:'https://example.com/v1',model:'test',delay:200,hideDelay:180,enabled:true}).map(([k,v])=>['extensions.sentenceHover.'+k,v]));
  const scope={URL,Zotero:{Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},HTTP:{request},getMainWindow:()=>win,Reader:{_readers:[{_iframeWindow:win,_window:host}]}},Services:{},Components:{utils:{cloneInto:x=>x}}};
  if(fullSetup){
    scope.PathUtils={join:(...a)=>a.join('/'),parent:p=>p.slice(0,p.lastIndexOf('/'))};
    scope.IOUtils={
      exists:async p=>p.endsWith('.pdf')||fullSetup.disk.has(p),
      stat:async p=>({size:fullSetup.disk.get(p).length}),
      readJSON:async p=>JSON.parse(fullSetup.disk.get(p)),
      writeJSON:async(p,d)=>fullSetup.disk.set(p,JSON.stringify(d))
    };
    scope.Zotero.Reader._readers[0]._item={key:'ARTICLE1',getFilePathAsync:async()=>'/storage/ARTICLE1/paper.pdf'};
    win.PDFViewerApplication.pdfDocument.numPages=fullSetup.pageCount||1;
    if(fullSetup.getPageData)win.PDFViewerApplication.pdfDocument.getPageData=fullSetup.getPageData;
  }
  vm.createContext(scope);
  for(const file of ['core.js','cache.js','fulltext.js','addon.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),scope);
  let scanTick;
  const nativeInterval=win.setInterval.bind(win);
  win.setInterval=(fn,delay)=>{scanTick=fn;return nativeInterval(fn,delay);};
  const api=scope.SentenceHover;api.start();
  doc.getElementById('sentence-hover-popup').getBoundingClientRect=()=>({width:480,height:120});
  return {api,win,host,doc,readers:scope.Zotero.Reader._readers,rescan:()=>scanTick(),move:(x,y=16)=>page.dispatchEvent(new win.MouseEvent('mousemove',{bubbles:true,clientX:pageLeft+x,clientY:pageTop+y})),close:()=>{api.stop();win.close();host.close();}};
}
test('one-click full translation caches every sentence and hover reuses persisted full archive after restart',async()=>{
  const disk=new Map();let calls=0;
  const request=async(method,url,options)=>{
    calls++;
    const data=JSON.parse(JSON.parse(options.body).messages[1].content);
    return {response:{choices:[{message:{content:JSON.stringify({segments:[{text:'整句译文',source:data.tokens.map(t=>t.id)}]})}}]}};
  };
  const f=fixture(request,0,'normal',0,false,{disk});
  try{
    const bar=f.doc.getElementById('sentence-hover-fulltext'),button=bar;
    assert.equal(button.localName,'button');assert.equal(button.children.length,0);
    button.click();await wait(80);
    assert.equal(bar.textContent,'全文翻译 ✓');assert.match(bar.title,/已完成 2\/2/);assert.equal(calls,2);
    const file=[...disk.keys()].find(p=>p.includes('sentence-hover-fulltext-'));
    assert.ok(file?.startsWith('/storage/ARTICLE1/'));
    const stored=JSON.parse(disk.get(file));assert.equal(stored.results.length,2);
    assert.equal(stored.results[0][1].words.length,3);
    f.move(12);await wait(280);assert.equal(calls,2);
    assert.ok(f.doc.getElementById('sentence-hover-popup').textContent.includes('整句译文'));
  }finally{f.close();}
  const g=fixture(request,0,'normal',0,false,{disk});
  try{
    g.move(12);await wait(280);assert.equal(calls,2);
    assert.ok(g.doc.getElementById('sentence-hover-popup').textContent.includes('整句译文'));
    await g.api.reset();
    for(const [p,d] of disk)if(p.includes('sentence-hover-fulltext-'))assert.equal(JSON.parse(d).results.length,0);
  }finally{g.close();}
});
test('three background requests leave capacity for foreground hover translation',async()=>{
  const text='One. Two. Three. Four. Five.';
  const chars=Array.from(text,(c,i)=>({c,rect:[i*8,10,i*8+8,24]}));
  const waiting=new Map(),calls=[];let active=0,peak=0;
  const f=fixture(async(method,url,options)=>{
    const data=JSON.parse(JSON.parse(options.body).messages[1].content);
    calls.push(data.sentence);active++;peak=Math.max(peak,active);
    await new Promise(r=>waiting.set(data.sentence,()=>{active--;waiting.delete(data.sentence);r();}));
    return {response:{choices:[{message:{content:JSON.stringify({segments:[{text:'译文 '+data.sentence,source:[0]}]})}}]}};
  },0,'normal',0,false,{disk:new Map(),getPageData:async()=>({chars})});
  try{
    const button=f.doc.getElementById('sentence-hover-fulltext');
    button.click();await wait(60);assert.equal(calls.length,3);assert.equal(active,3);
    f.move(text.indexOf('Five')*8+4);await wait(280);
    assert.equal(active,4);assert.ok(waiting.has('Five.'));
    waiting.get('Five.')();await wait(50);
    assert.ok(f.doc.getElementById('sentence-hover-popup').textContent.includes('Five.'));
    while(waiting.size){[...waiting.values()].forEach(r=>r());await wait(30);}
    await wait(30);assert.equal(button.textContent,'全文翻译 ✓');
    assert.equal(peak,4);assert.equal(calls.filter(t=>t==='Five.').length,1);
  }finally{for(const finish of waiting.values())finish();f.close();}
});
test('full translation cancel aborts its request and allows retry without leaving the reader',async()=>{
  const disk=new Map();let calls=0,aborts=0;
  const f=fixture(async(method,url,options)=>{
    calls++;
    if(calls===1)return new Promise((resolve,reject)=>options.requestObserver({abort(){aborts++;reject(new Error('abort'));}}));
    const data=JSON.parse(JSON.parse(options.body).messages[1].content);
    return {response:{choices:[{message:{content:JSON.stringify({segments:[{text:'译文',source:data.tokens.map(t=>t.id)}]})}}]}};
  },0,'normal',0,false,{disk});
  try{
    const bar=f.doc.getElementById('sentence-hover-fulltext'),start=bar;
    start.click();await wait(50);assert.match(start.textContent,/取消/);assert.equal(start.disabled,false);start.click();await wait(50);
    assert.equal(aborts,1);assert.match(bar.title,/已取消/);assert.equal(start.disabled,false);
    start.click();await wait(80);assert.equal(bar.textContent,'全文翻译 ✓');
  }finally{f.close();}
});
test('closing reader cancels full translation before accessing dead page objects',async()=>{
  let aborts=0;
  const f=fixture(async(method,url,options)=>new Promise((resolve,reject)=>options.requestObserver({abort(){aborts++;reject(new Error('abort'));}})),0,'normal',0,false,{disk:new Map()});
  try{
    f.doc.getElementById('sentence-hover-fulltext').click();await wait(60);
    f.win.dispatchEvent(new f.win.Event('unload'));await wait(60);
    assert.equal(aborts,2);assert.equal(f.doc.getElementById('sentence-hover-fulltext'),null);
  }finally{f.close();}
});
test('full translation has one compact button and repeated scans cannot add duplicates',()=>{
  const f=fixture(async()=>answer);
  try{
    for(let i=0;i<5;i++)f.rescan();
    const nodes=f.doc.querySelectorAll('#sentence-hover-fulltext');
    assert.equal(nodes.length,1);assert.equal(nodes[0].localName,'button');
    assert.equal(nodes[0].textContent,'全文翻译');assert.equal(nodes[0].childElementCount,0);
    assert.doesNotMatch(f.doc.body.textContent,/按服务商规则计费|已缓存句子不重复请求/);
  }finally{f.close();}
});
test('wrapper PDF app and split views expose only one full-translation control per reader',()=>{
  const f=fixture(async()=>answer);
  const outer=new JSDOM('<body><iframe></iframe><iframe></iframe></body>',{pretendToBeVisual:true}).window;
  const second=new JSDOM('<body><div class="pdfViewer"></div></body>',{pretendToBeVisual:true}).window;
  try{
    outer.PDFViewerApplication=f.win.PDFViewerApplication;
    second.PDFViewerApplication=f.win.PDFViewerApplication;
    const frames=outer.document.querySelectorAll('iframe');
    Object.defineProperty(frames[0],'contentWindow',{value:f.win});
    Object.defineProperty(frames[1],'contentWindow',{value:second});
    f.readers[0]._iframeWindow=outer;
    f.rescan();f.rescan();
    assert.equal(outer.document.querySelectorAll('#sentence-hover-fulltext').length,0);
    assert.equal(f.doc.querySelectorAll('#sentence-hover-fulltext').length,1);
    assert.equal(f.doc.getElementById('sentence-hover-fulltext').style.display,'');
    assert.equal(second.document.getElementById('sentence-hover-fulltext').style.display,'none');
    assert.equal(f.api.diagnostic().connectedPDFViews,2);
  }finally{f.close();outer.close();second.close();}
});
test('the same page exposed through two frame references retains its single visible control',()=>{
  const f=fixture(async()=>answer);
  const outer=new JSDOM('<body><iframe></iframe><iframe></iframe></body>',{pretendToBeVisual:true}).window;
  try{
    for(const frame of outer.document.querySelectorAll('iframe'))Object.defineProperty(frame,'contentWindow',{value:f.win});
    f.readers[0]._iframeWindow=outer;f.rescan();
    assert.equal(f.doc.querySelectorAll('#sentence-hover-fulltext').length,1);
    assert.equal(f.doc.getElementById('sentence-hover-fulltext').style.display,'');
  }finally{f.close();outer.close();}
});
test('saving after a dead reader object still permits test translation and removes host listeners',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(280);
    const overlay=f.doc.getElementById('sentence-hover-word-highlight');
    const box=f.doc.getElementById('sentence-hover-popup');
    overlay.replaceChildren=()=>{throw new Error("can't access dead object");};
    box.remove=()=>{throw new Error("can't access dead object");};
    assert.doesNotThrow(()=>f.api.save({...f.api.config(),model:'changed'}));
    assert.equal(f.api.diagnostic().connectedPDFViews,0);
    assert.equal((await f.api.translate('Sleep improves memory.',{force:true})).text,'睡眠改善记忆。');
    assert.equal(calls,2);
    f.host.document.dispatchEvent(new f.host.KeyboardEvent('keydown',{key:'r',ctrlKey:true,altKey:true}));
    await wait(40);assert.equal(calls,2);
  }finally{f.close();}
});
test('reader unload invalidates pending response before cleanup can fail',async()=>{
  let finish;const f=fixture(async()=>{await new Promise(r=>finish=r);return answer;});
  try{
    f.move(12);await wait(270);
    const box=f.doc.getElementById('sentence-hover-popup');
    let writes=0;
    box.remove=()=>{throw new Error("can't access dead object");};
    const label=box.lastChild;
    Object.defineProperty(label,'textContent',{set(){writes++;throw new Error("can't access dead object");}});
    f.win.dispatchEvent(new f.win.Event('unload'));
    assert.equal(f.api.diagnostic().connectedPDFViews,0);
    finish();await wait(50);assert.equal(writes,0);
    assert.doesNotThrow(()=>f.api.saveAppearance({fontSize:22}));
  }finally{f.close();}
});
test('crossing line gap within same sentence retains popup and updates next-line highlight',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;},0,'normal',0,true);
  try{
    f.move(64,16);await wait(280);const box=f.doc.getElementById('sentence-hover-popup');
    f.move(70,29);await wait(70);assert.equal(box.style.display,'block');
    f.move(12,40);await wait(70);assert.equal(box.style.display,'block');assert.equal(calls,1);
    assert.equal([...box.querySelectorAll('span')].find(s=>s.style.background)?.textContent,'记忆。');
    f.move(400,29);await wait(140);assert.equal(box.style.display,'none');
  }finally{f.close();}
});
test('source word highlights before API call, moves with pointer and clears without annotations',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;},300,'normal',300);
  try{
    const overlay=f.doc.getElementById('sentence-hover-word-highlight');
    f.move(12);await wait(60);
    assert.equal(calls,0);assert.equal(overlay.style.pointerEvents,'none');
    assert.equal(overlay.children.length,5);assert.equal(overlay.firstChild.style.left,'300px');
    assert.equal(overlay.firstChild.style.top,'310px');
    f.move(64);await wait(60);
    assert.equal(overlay.children.length,8);assert.equal(overlay.firstChild.style.left,'348px');
    await wait(180);assert.equal(calls,1);
    f.move(44);await wait(60);assert.equal(overlay.children.length,8);
    f.doc.dispatchEvent(new f.win.Event('scroll'));assert.equal(overlay.children.length,0);
    f.api.stop();assert.equal(f.doc.getElementById('sentence-hover-word-highlight'),null);
  }finally{f.close();}
});
test('source highlight switch updates immediately while translation and target highlighting continue',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(280);
    const overlay=f.doc.getElementById('sentence-hover-word-highlight'),box=f.doc.getElementById('sentence-hover-popup');
    assert.equal(f.api.config().highlightSourceWord,true);assert.ok(overlay.children.length);
    f.api.setSourceHighlight(false);assert.equal(overlay.children.length,0);assert.equal(f.api.config().highlightSourceWord,false);
    f.move(64);await wait(70);assert.equal(overlay.children.length,0);assert.equal(box.style.display,'block');
    assert.equal([...box.querySelectorAll('span')].find(s=>s.style.background)?.textContent,'改善');
    f.api.setSourceHighlight(true);assert.equal(overlay.children.length,8);assert.equal(calls,1);
  }finally{f.close();}
});
test('appearance updates visible popup without dismissing it or making another request',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;},300,'normal',300);
  try{
    f.move(12);await wait(280);const box=f.doc.getElementById('sentence-hover-popup');
    f.api.saveAppearance({fontSize:26,popupWidth:800,transparency:40});
    assert.equal(box.style.display,'block');assert.equal(calls,1);
    assert.equal(box.lastChild.style.fontSize,'26px');
    const expected=f.doc.createElement('div');expected.style.maxWidth='min(800px, calc(100vw - 24px))';
    assert.equal(box.style.maxWidth,expected.style.maxWidth);
    assert.equal(box.style.backgroundColor,'rgba(255, 255, 255, 0.6)');
    assert.equal(box.style.opacity,'');assert.equal(box.style.left,'148px');
    f.move(64);await wait(70);
    assert.equal([...box.querySelectorAll('span')].find(s=>s.style.background)?.textContent,'改善');
  }finally{f.close();}
});
test('shortcut in host window reaches hovered PDF with physical KeyR and shows progress',async()=>{
  let calls=0,finish;const f=fixture(async()=>{calls++;if(calls===2)await new Promise(r=>finish=r);return answer;});
  try{
    f.move(12);await wait(280);
    const press=()=>f.host.document.dispatchEvent(new f.host.KeyboardEvent('keydown',{key:'®',code:'KeyR',ctrlKey:true,altKey:true,cancelable:true}));
    press();await wait(40);assert.equal(calls,2);
    const button=f.doc.querySelector('[aria-label="重新翻译当前句子"]');assert.equal(button.textContent,'…');assert.equal(button.disabled,true);
    finish();await wait(50);assert.equal(button.textContent,'↻');
    f.api.stop();press();await wait(40);assert.equal(calls,2);
  }finally{f.close();}
});
test('refresh button bypasses cache without keyboard focus',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(280);f.doc.querySelector('[aria-label="重新翻译当前句子"]').click();await wait(60);assert.equal(calls,2);
  }finally{f.close();}
});
test('host editable field does not trigger PDF retranslation',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(280);const input=f.host.document.createElement('input');f.host.document.body.append(input);
    input.dispatchEvent(new f.host.KeyboardEvent('keydown',{key:'r',code:'KeyR',ctrlKey:true,altKey:true,bubbles:true}));await wait(50);assert.equal(calls,1);
  }finally{f.close();}
});
test('leaving uses 100ms delay; returning or entering popup cancels closing',async()=>{
  const f=fixture(async()=>answer);
  try{
    f.move(12);await wait(280);const box=f.doc.getElementById('sentence-hover-popup');
    f.move(600);await wait(60);assert.equal(box.style.display,'block');
    f.move(12);await wait(140);assert.equal(box.style.display,'block');
    f.move(600);await wait(60);assert.equal(box.style.display,'block');
    box.dispatchEvent(new f.win.MouseEvent('mouseenter'));await wait(240);assert.equal(box.style.display,'block');
    box.dispatchEvent(new f.win.MouseEvent('mouseleave'));assert.equal(box.style.display,'block');
    await wait(140);assert.equal(box.style.display,'none');
  }finally{f.close();}
});
test('changing sentence hides old popup immediately and returning reuses cache',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(280);const box=f.doc.getElementById('sentence-hover-popup');const before=box.textContent;
    f.move(200);await wait(0);assert.equal(box.style.display,'none');await wait(80);
    f.move(12);await wait(280);assert.equal(calls,1);
  }finally{f.close();}
});
test('shortcut bypasses cache and does not duplicate requests while busy',async()=>{
  let calls=0,finish;const f=fixture(async()=>{calls++;if(calls===2)await new Promise(r=>finish=r);return answer;});
  try{
    f.move(12);await wait(280);
    const press=()=>f.doc.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'r',ctrlKey:true,altKey:true,cancelable:true}));
    press();await wait(30);press();await wait(30);assert.equal(calls,2);
    finish();await wait(60);assert.ok(f.doc.getElementById('sentence-hover-popup').textContent.includes('睡眠改善记忆。'));
  }finally{f.close();}
});
test('selecting translated text does not close popup',async()=>{
  const f=fixture(async()=>answer);
  try{
    f.move(12);await wait(280);const box=f.doc.getElementById('sentence-hover-popup');
    const range=f.doc.createRange();range.selectNodeContents(box.lastChild);f.win.getSelection().addRange(range);
    f.doc.dispatchEvent(new f.win.Event('selectionchange'));assert.equal(box.style.display,'block');
  }finally{f.close();}
});
test('late result from previous sentence does not replace new sentence',async()=>{
  let release,calls=0;
  const second={response:{choices:[{message:{content:JSON.stringify({segments:[{text:'研究有帮助。',source:[0,1]}]})}}]}};
  const f=fixture(async()=>{calls++;if(calls===1){await new Promise(r=>release=r);return answer;}return second;});
  try{
    f.move(12);await wait(270);f.move(200);await wait(270);
    const box=f.doc.getElementById('sentence-hover-popup');assert.ok(box.textContent.includes('研究有帮助。'));
    release();await wait(50);assert.ok(box.textContent.includes('研究有帮助。'));assert.ok(!box.textContent.includes('睡眠'));
  }finally{f.close();}
});
test('shortcut is ignored in editable controls',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(280);const input=f.doc.createElement('input');f.doc.body.appendChild(input);
    input.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'r',ctrlKey:true,altKey:true,bubbles:true}));
    await wait(60);assert.equal(calls,1);
  }finally{f.close();}
});
const answer={response:{choices:[{message:{content:JSON.stringify({segments:[{text:'睡眠',source:[0]},{text:'改善',source:[1]},{text:'记忆。',source:[2]}]})}}]}};
test('moving across a word space or punctuation keeps popup and next word updates highlight',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(280);const box=f.doc.getElementById('sentence-hover-popup');
    f.move(44);await wait(70);assert.equal(box.style.display,'block');
    f.move(64);await wait(70);assert.equal(box.style.display,'block');
    assert.equal([...box.querySelectorAll('span')].find(s=>s.style.background)?.textContent,'改善');
    f.move(172);await wait(70);assert.equal(box.style.display,'block');assert.equal(calls,1);
    f.move(400);await wait(140);assert.equal(box.style.display,'none');
  }finally{f.close();}
});
test('space crossed during initial hover does not reset opening delay',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return answer;});
  try{
    f.move(12);await wait(100);f.move(44);await wait(160);
    assert.equal(f.doc.getElementById('sentence-hover-popup').style.display,'block');assert.equal(calls,1);
  }finally{f.close();}
});
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
