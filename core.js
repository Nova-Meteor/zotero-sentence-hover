/* Original implementation. Pure text/alignment functions, shared with tests. */
(function (root) {
  'use strict';
  function words(text) {
    return Array.from(text.matchAll(/[A-Za-z]+(?:['’−-][A-Za-z]+)*/g), (m, id) =>
      ({ id, text: m[0], start: m.index, end: m.index + m[0].length }));
  }
  function sentences(text) {
    const out = [];
    let start = 0;
    const push = end => {
      const raw = text.slice(start, end), trimmed = raw.trim();
      if (trimmed) out.push({ text: trimmed, start: start + raw.indexOf(trimmed), end: start + raw.indexOf(trimmed) + trimmed.length });
      start = end;
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\n') { push(i); start = i + 1; continue; }
      if (!/[.!?]/.test(c)) continue;
      if (c === '.') {
        if (/\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue;
        const prefix = text.slice(start, i + 1);
        if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Fig|Figs|Eq|Eqs|Ref|Refs|vs|al|No|Vol|pp)\.$/i.test(prefix)) continue;
        if (/(?:\b[A-Za-z]\.){2,}$/.test(prefix) || /\b[A-Z]\.$/.test(prefix)) continue;
        if (/\b(?:e\.g|i\.e)\.$/i.test(prefix)) continue;
      }
      let end = i + 1;
      while (/[.!?"'”’)]/.test(text[end] || '') && end < text.length) end++;
      if (end === text.length || /\s/.test(text[end])) { push(end); i = end - 1; }
    }
    push(text.length);
    return out;
  }
  function buildPage(chars) {
    let text = '';
    const anchors = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch.ignorable || typeof ch.c !== 'string' || !Array.isArray(ch.rect)) continue;
      let s = ch.c.normalize('NFKC');
      // Remove printed line-end hyphens only when both sides are letters.
      const next = chars.slice(i + 1, i + 5).find(x => !x.ignorable && x.c);
      const joined = /[-‐]$/.test(s) && ch.lineBreakAfter && !ch.paragraphBreakAfter && /[A-Za-z]$/.test(text) && /^[a-z]/.test(next?.c || '');
      if (joined) s = s.slice(0, -1);
      const start = text.length;
      text += s;
      if (s) anchors.push({ start, end: text.length, rect: ch.rect.slice(), inlineRect: (ch.inlineRect || ch.rect).slice() });
      if (ch.paragraphBreakAfter) text += '\n';
      else if (!joined && (ch.spaceAfter || ch.lineBreakAfter)) text += ' ';
    }
    const segments = sentences(text).map(s => ({ ...s, words: words(s.text) }));
    return { text, anchors, segments };
  }
  function atPoint(page, x, y) {
    const candidates = page.anchors.filter(a => { const r = a.inlineRect; return x >= Math.min(r[0],r[2]) && x <= Math.max(r[0],r[2]) && y >= Math.min(r[1],r[3]) && y <= Math.max(r[1],r[3]); });
    candidates.sort((a,b) => Math.abs(x-(a.rect[0]+a.rect[2])/2) - Math.abs(x-(b.rect[0]+b.rect[2])/2));
    const a = candidates[0];
    if (!a) return null;
    const sentence = page.segments.find(s => a.start >= s.start && a.start < s.end);
    if (!sentence) return null;
    const word = sentence.words.find(w => a.start - sentence.start >= w.start && a.start - sentence.start < w.end);
    return word ? { sentence, word } : null;
  }
  function parseResult(raw, tokenCount) {
    const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const data = JSON.parse(clean);
    if (!Array.isArray(data.segments) || !data.segments.length || data.segments.length > 1000) throw new Error('模型没有返回有效的译文分段，请换用支持 JSON 输出的模型。');
    let length = 0;
    const segments = data.segments.map(s => {
      if (typeof s.text !== 'string' || !Array.isArray(s.source)) throw new Error('译文对应关系格式错误。');
      length += s.text.length;
      const source = [...new Set(s.source)];
      if (source.some(id => !Number.isInteger(id) || id < 0 || id >= tokenCount)) throw new Error('模型返回了不存在的英文词编号。');
      return { text: s.text, source };
    });
    if (!length || length > 12000) throw new Error('译文长度异常。');
    return { segments, text: segments.map(s => s.text).join('') };
  }
  function endpoint(value) {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不要包含用户名、密码、查询参数或锚点。');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('请使用 HTTPS 地址；本机服务可以使用 HTTP。');
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions';
    return url.toString();
  }
  const api = { words, sentences, buildPage, atPoint, parseResult, endpoint };
  root.SHCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
