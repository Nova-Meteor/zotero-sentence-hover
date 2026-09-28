/* Whole-document jobs and durable word alignment archives, independent of the UI. */
(function(root) {
  'use strict';
  function signal() {
    const callbacks = new Set();
    let resolve;
    const cancelled = new Promise(r => { resolve = r; });
    return {
      cancelled: false, reason: '', promise: cancelled,
      onCancel(fn) { callbacks.add(fn); return () => callbacks.delete(fn); },
      cancel(reason = '已取消') {
        if (this.cancelled) return;
        this.cancelled = true; this.reason = reason; resolve();
        for (const fn of callbacks) { try { fn(); } catch (_) {} }
        callbacks.clear();
      }
    };
  }
  const stopped = s => { if (s.cancelled) throw new Error(s.reason); };
  async function interruptible(promise, s) {
    const value = await Promise.race([promise, s.promise]);
    stopped(s); return value;
  }
  function aligned(text, result) {
    return {
      text: result.text, segments: result.segments,
      words: SHCore.words(text).map(w => {
        const targetSegments = [];
        result.segments.forEach((seg,i) => { if (seg.source.includes(w.id)) targetSegments.push(i); });
        return { ...w, targetSegments, status: targetSegments.length ? 'mapped' : 'unmapped' };
      })
    };
  }
  function create({ id, serviceKey, title = '全文翻译', storage = null, translate }) {
    const results = new Map(), listeners = new Set();
    let pages = [], pageErrors = [], state = { phase:'idle', pages:0, pageCount:0, total:0, done:0, failed:0, emptyPages:0, message:'' };
    let task = null, token = null, writes = Promise.resolve(), hasStored = false;
    const emit = () => { for (const fn of listeners) { try { fn({ ...state }); } catch (_) {} } };
    const ready = (async () => {
      if (!storage) return;
      try {
        const data = await storage.read();
        if (!data) return;
        hasStored = true;
        if (data.schema !== 1 || data.id !== id || data.serviceKey !== serviceKey || !Array.isArray(data.results)) throw new Error('Invalid archive');
        for (const [text, result] of data.results) {
          try {
            if (typeof text !== 'string' || text.length > 1800 || !SHCore.words(text).length) continue;
            results.set(text, aligned(text, SHCore.parseResult(JSON.stringify(result), SHCore.words(text).length)));
          } catch (_) {}
        }
        if (Array.isArray(data.pages)) pages = data.pages.filter(p => Number.isInteger(p.pageIndex) && Array.isArray(p.sentences))
          .map(p => ({ pageIndex:p.pageIndex, sentences:p.sentences.filter(t => typeof t === 'string') }));
      } catch (_) { state.message = '全文缓存读取失败，将重新生成。'; }
    })();
    function snapshot() {
      return { schema:1, id, serviceKey, title, pages, pageErrors, results:[...results], state:{...state}, updatedAt:new Date().toISOString() };
    }
    function persist() {
      writes = writes.catch(()=>{}).then(async () => {
        if (storage) { await storage.write(snapshot()); hasStored = true; }
      }).catch(() => { state.phase = 'error'; state.message = '全文缓存保存失败，请检查 PDF 目录权限或磁盘空间。'; emit(); throw new Error(state.message); });
      // Handlers are installed immediately even when the UI is closed.
      writes.catch(() => {});
      return writes;
    }
    async function run({ pageCount, getPage, concurrency = 3 }) {
      if (task) return task;
      const n=Number(concurrency);
      const parallel=Number.isFinite(n)?Math.max(1,Math.min(6,Math.floor(n))):3;
      writes = writes.catch(()=>{});
      token = signal(); const s = token;
      state = { phase:'extracting', pages:0, pageCount, total:0, done:0, failed:0, emptyPages:0, message:'' };
      emit();
      task = (async () => {
        try {
          await ready; stopped(s);
          pages = []; pageErrors = [];
          const todo = new Set();
          for (let i=0; i<pageCount; i++) {
            stopped(s);
            try {
              const page = await interruptible(Promise.resolve().then(() => getPage(i)), s);
              const texts = page.segments.map(v => v.text).filter(Boolean);
              pages.push({ pageIndex:i, sentences:texts });
              const english = texts.filter(t => SHCore.words(t).length);
              if (!english.length) state.emptyPages++;
              for (const text of english) todo.add(text);
            } catch(e) {
              stopped(s); pageErrors.push(i+1);
            }
            state.pages = i+1; state.total = todo.size; emit();
          }
          stopped(s);
          // Remove results for content no longer present in this PDF.
          if (!pageErrors.length) {
            for (const text of results.keys()) if (!todo.has(text)) results.delete(text);
          }
          state.phase = 'translating'; state.done = [...todo].filter(t=>results.has(t)).length; emit();
          await persist();
          const queue=[...todo].filter(text=>!results.has(text));
          let next=0, dirty=0, halted=false, storageError=null;
          async function worker() {
            while(!s.cancelled && !halted && next<queue.length) {
              // Claim synchronously before awaiting so workers cannot duplicate a sentence.
              const text=queue[next++];
              try {
                const result=await interruptible(Promise.resolve().then(()=>translate(text,s)),s);
                results.set(text,aligned(text,result));state.done++;dirty++;
              } catch(e) {
                if(s.cancelled) return;
                state.failed++;
                if(!halted)state.message=e.message || '部分句子翻译失败';
                if(state.failed>=3 || /认证|受限|余额/.test(state.message))halted=true;
              }
              emit();
              if(dirty>=10 && !storageError) {
                dirty=0;
                try { await persist(); }
                catch(e) { storageError=e;halted=true; }
              }
            }
          }
          // Drain all workers before publishing a final state or clearing caches.
          await Promise.all(Array.from({length:Math.min(parallel,queue.length)},()=>worker()));
          stopped(s);
          if(storageError)throw storageError;
          state.phase = state.done === state.total && !pageErrors.length && !state.emptyPages && state.total > 0 ? 'complete' : 'partial';
          state.message = state.phase === 'complete' ? '全文翻译完成' : (state.message || '存在未完成句子、无可译英文的页面或读取失败的页面');
        } catch(e) {
          state.phase = s.cancelled ? 'cancelled' : 'error'; state.message = s.cancelled ? s.reason : e.message;
        } finally {
          // Cancellation retains completed work; storage failures are never called success.
          try { await persist(); } catch (_) {}
          emit(); task = null;
        }
        return { ...state };
      })();
      return task;
    }
    return {
      ready, run,
      get: text => results.get(text) || null,
      async put(text,result) { await ready; results.set(text,aligned(text,result)); await persist(); },
      status: () => ({...state}),
      subscribe(fn) { listeners.add(fn); fn({...state}); return () => listeners.delete(fn); },
      cancel(reason) { token?.cancel(reason); },
      async settle() { if (task) await task; await writes; },
      async clear() {
        token?.cancel('缓存已清空'); if (task) await task; await ready;
        const needsWrite = hasStored || results.size || pages.length;
        results.clear(); pages=[]; pageErrors=[]; state={phase:'idle',pages:0,pageCount:0,total:0,done:0,failed:0,emptyPages:0,message:''};
        writes = writes.catch(()=>{}); if (needsWrite) await persist(); emit();
      },
      snapshot
    };
  }
  root.SHFullText = { create, aligned };
})(globalThis);
