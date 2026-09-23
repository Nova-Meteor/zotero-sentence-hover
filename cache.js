/* Versioned local LRU cache. Storage is injected so disk failures are testable. */
(function(root) {
  'use strict';
  const REVISION = 'en-zh-alignment-1';
  function create({ storage = null, limit = 1000, maxChars = 2000000, now = Date.now } = {}) {
    const entries = new Map();
    let error = '', chain = Promise.resolve(), dirty = false;
    const ttl = 90 * 24 * 60 * 60 * 1000;
    const key = (endpoint, model, sentence) => JSON.stringify([REVISION, endpoint, model, sentence]);
    function prune() {
      for (const [k,v] of entries) if (now() - v.used > ttl) entries.delete(k);
      let size = 0;
      for (const [k,v] of [...entries].reverse()) {
        size += JSON.stringify([k,v]).length;
        if (size > maxChars) entries.delete(k);
      }
      while(entries.size > limit) entries.delete(entries.keys().next().value);
    }
    const ready = (async () => {
      if (!storage) return;
      try {
        const data = await storage.read();
        if (data == null) return;
        if (data.schema !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid cache');
        for (const row of data.entries.slice(-limit)) {
          try {
            const [k, value] = row, [revision, endpoint, model, sentence] = JSON.parse(k);
            if (revision !== REVISION || typeof model !== 'string' || typeof sentence !== 'string' || sentence.length > 1800 || SHCore.endpoint(endpoint) !== endpoint) continue;
            if (!Number.isFinite(value.used) || value.used > now() + 60000 || now() - value.used > ttl) continue;
            const result = SHCore.parseResult(JSON.stringify(value.result), SHCore.words(sentence).length);
            entries.set(k, { result, used: value.used });
          } catch (_) { /* A damaged entry must not discard other sentences. */ }
        }
        prune();
      } catch (_) { error = '本地缓存读取失败，已使用内存缓存；新译文会尝试重新保存。'; }
    })();
    function persist() {
      if (!storage) return chain;
      dirty = true;
      chain = chain.then(async () => {
        await ready;
        if (!dirty) return;
        dirty = false; prune();
        const snapshot = { schema: 1, entries: [...entries] };
        try { await storage.write(snapshot); error = ''; }
        catch (_) { error = '本地缓存保存失败，当前译文仍可使用；请检查磁盘空间或目录权限。'; }
      });
      return chain;
    }
    return {
      ready, key,
      get(k) {
        const entry = entries.get(k);
        if (!entry) return null;
        if (now() - entry.used > ttl) { entries.delete(k); return null; }
        entry.used = now(); entries.delete(k); entries.set(k, entry);
        persist(); return entry.result;
      },
      put(k, result) { entries.delete(k); entries.set(k, { result, used: now() }); prune(); persist(); },
      async clear() { await ready; entries.clear(); await persist(); if (error) throw new Error(error); },
      async flush() { await ready; await chain; },
      status: () => ({ persistent: !!storage, count: entries.size, error })
    };
  }
  root.SHCache = { create };
})(globalThis);
