window.SHPrefs = {
  init() {
    const api = Zotero.SentenceHover;
    const get = name => document.getElementById('sh-' + name);
    const keys = ['enabled','baseURL','model','apiKey','delay'];
    const c = api.config();
    for (const key of keys) { if (key === 'enabled') get(key).checked = c[key]; else get(key).value = c[key]; }
    const save = () => {
      const values = Object.fromEntries(keys.map(key => [key, key === 'enabled' ? get(key).checked : get(key).value]));
      api.save(values);
    };
    get('save').onclick = () => { try { save(); get('status').textContent = '已保存。请在 PDF 英文句子上悬停。'; } catch(e) { get('status').textContent = e.message; } };
    get('test').onclick = async () => {
      get('test').disabled = true;
      try {
        save(); get('status').textContent = '正在测试…';
        const result = await api.translate('The researchers found that sleep improves memory.');
        const d = api.diagnostic();
        const mapped = result.segments.filter(s => s.source.includes(4)).map(s => s.text).join(' / ');
        get('status').textContent = '连接成功：' + result.text + '\nsleep 对应：' + (mapped || '模型未提供映射') + '\n已连接 PDF 视图：' + d.connectedPDFViews;
      } catch (e) { get('status').textContent = e.message; } finally { get('test').disabled = false; }
    };
    get('clear').onclick = () => { api.reset(); get('status').textContent = '已清空缓存。'; };
  }
};
