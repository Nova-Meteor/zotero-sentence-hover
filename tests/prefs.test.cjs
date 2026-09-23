const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require(process.env.SH_JSDOM || 'jsdom');
test('appearance preview, independent save and defaults work without API configuration',()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'..','prefs.xhtml'),'utf8'),{contentType:'application/xhtml+xml'});
  const values={enabled:true,baseURL:'',model:'',apiKey:'',delay:500,fontSize:17,popupWidth:640,transparency:0};
  let saved=0;
  const api={
    config:()=>values,
    normalizeAppearance:v=>Object.fromEntries(['fontSize','popupWidth','transparency'].map(k=>[k,Number(v[k])])),
    saveAppearance(v){saved++;const a=this.normalizeAppearance(v);Object.assign(values,a);return a;},
    diagnostic:()=>({cache:{error:''}})
  };
  const scope={window:dom.window,document:dom.window.document,Zotero:{SentenceHover:api}};
  try{
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','prefs.js'),'utf8'),scope);
    dom.window.SHPrefs.init();
    const get=k=>dom.window.document.getElementById('sh-'+k);
    get('fontSize').value='24';get('popupWidth').value='900';get('transparency').value='50';
    get('transparency').dispatchEvent(new dom.window.Event('input'));
    assert.equal(get('preview').style.fontSize,'24px');assert.equal(get('transparencyValue').textContent,'50%');
    assert.equal(get('preview').style.backgroundColor,'rgba(255, 255, 255, 0.5)');assert.equal(saved,0);
    get('saveAppearance').click();assert.equal(saved,1);assert.equal(values.popupWidth,900);
    get('defaultAppearance').click();assert.equal(saved,2);assert.equal(values.fontSize,17);assert.equal(values.popupWidth,640);assert.equal(values.transparency,0);
  }finally{dom.window.close();}
});
