window.SHPrefs = {
  init() {
    const api = Zotero.SentenceHover;
    const get = name => document.getElementById('sh-' + name);
    const appearanceKeys = ['fontSize','popupWidth','transparency'];
    const keys = ['enabled','baseURL','model','apiKey','delay',...appearanceKeys];
    const c = api.config();
    for (const key of keys) { if (key === 'enabled') get(key).checked = c[key]; else get(key).value = c[key]; }
    const appearanceValues = () => Object.fromEntries(appearanceKeys.map(key => [key, get(key).value]));
    const preview = () => {
      const a = api.normalizeAppearance(appearanceValues());
      get('preview').style.fontSize = a.fontSize + 'px';
      get('preview').style.maxWidth = 'min(' + a.popupWidth + 'px, 100%)';
      get('preview').style.backgroundColor = 'rgba(255, 255, 255, ' + (1-a.transparency/100) + ')';
      get('transparencyValue').textContent = a.transparency + '%';
    };
    for (const key of appearanceKeys) get(key).addEventListener('input', preview);
    const applyAppearance = values => {
      const a = api.saveAppearance(values);
      for (const key of appearanceKeys) get(key).value = a[key];
      preview(); get('status').textContent = '外观已保存，已打开的阅读器立即生效。';
    };
    get('saveAppearance').onclick = () => applyAppearance(appearanceValues());
    get('defaultAppearance').onclick = () => applyAppearance({ fontSize:17, popupWidth:640, transparency:0 });
    preview();
    const save = () => {
      const values = Object.fromEntries(keys.map(key => [key, key === 'enabled' ? get(key).checked : get(key).value]));
      api.save(values);
    };
    get('save').onclick = () => { try { save(); get('status').textContent = '已保存。请在 PDF 英文句子上悬停。'; } catch(e) { get('status').textContent = e.message; } };
    get('test').onclick = async () => {
      get('test').disabled = true;
      try {
        save(); get('status').textContent = '正在测试…';
        const result = await api.translate('The researchers found that sleep improves memory.', { force: true });
        const d = api.diagnostic();
        const mapped = result.segments.filter(s => s.source.includes(4)).map(s => s.text).join(' / ');
        await api.flushCache();
        get('status').textContent = '连接成功：' + result.text + '\nsleep 对应：' + (mapped || '模型未提供映射') + '\n已连接 PDF 视图：' + d.connectedPDFViews + (api.diagnostic().cache.error ? '\n' + api.diagnostic().cache.error : '');
      } catch (e) { get('status').textContent = e.message; } finally { get('test').disabled = false; }
    };
    get('clear').onclick = async () => {
      get('clear').disabled = true;
      try { await api.reset(); get('status').textContent = '已清空本次运行已加载文章的缓存。其他文章的缓存文件保留。'; }
      catch(e) { get('status').textContent = e.message; }
      finally { get('clear').disabled = false; }
    };
    const cacheStatus = api.diagnostic().cache;
    get('status').textContent = cacheStatus.error || '缓存保存在各 PDF 所在目录，重启后可复用。Ctrl+Alt+R 可重新翻译当前弹窗的句子。';
  }
};
