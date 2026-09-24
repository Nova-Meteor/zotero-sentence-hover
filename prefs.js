window.SHPrefs = {
  init() {
    const root = document.getElementById('sh-preferences');
    if (!root || root.getAttribute('data-initialized') === 'true') return;
    const api = Zotero.SentenceHover;
    const get = name => document.getElementById('sh-' + name);
    const feedbackTimers = new Map();
    let disposed = false;
    const updateUI = action => {
      if (disposed) return;
      try {
        if (!root.isConnected || window.closed) return;
        action();
      } catch (_) { /* Preferences can close or reload while a request completes. */ }
    };
    const notify = (name, message) => {
      updateUI(() => {
        window.clearTimeout(feedbackTimers.get(name));
        const node = get(name);
        node.textContent = message;
        feedbackTimers.set(name, window.setTimeout(() => {
          updateUI(() => { node.textContent = ''; }); feedbackTimers.delete(name);
        }, 2000));
      });
    };
    window.addEventListener('unload', () => {
      disposed = true;
      for (const timer of feedbackTimers.values()) window.clearTimeout(timer);
      feedbackTimers.clear();
    }, { once: true });
    const appearanceKeys = ['fontSize','popupWidth','transparency'];
    const booleanKeys = new Set(['enabled','highlightSourceWord']);
    const keys = ['enabled','highlightSourceWord','baseURL','model','apiKey','delay',...appearanceKeys];
    const c = api.config();
    for (const key of keys) { if (booleanKeys.has(key)) get(key).checked = c[key]; else get(key).value = c[key]; }
    get('highlightSourceWord').onchange = () => {
      api.setSourceHighlight(get('highlightSourceWord').checked);
      notify('save-status', get('highlightSourceWord').checked ? '原文单词高亮已开启。' : '原文单词高亮已关闭。');
    };
    const appearanceValues = () => Object.fromEntries(appearanceKeys.map(key => [key, get(key).value]));
    const preview = () => {
      const a = api.normalizeAppearance(appearanceValues());
      get('preview').style.fontSize = a.fontSize + 'px';
      get('preview').style.maxWidth = 'min(' + a.popupWidth + 'px, 100%)';
      get('preview').style.backgroundColor = 'rgba(255, 255, 255, ' + (1-a.transparency/100) + ')';
      get('fontSizeValue').textContent = a.fontSize + ' 像素';
      get('popupWidthValue').textContent = a.popupWidth + ' 像素';
      get('transparencyValue').textContent = a.transparency + '%';
    };
    for (const key of appearanceKeys) {
      get(key).addEventListener('input', preview);
      get(key).addEventListener('change', preview);
    }
    const applyAppearance = (values, target = 'appearance-status') => {
      try {
        const a = api.saveAppearance(values);
        for (const key of appearanceKeys) get(key).value = a[key];
        preview(); notify(target, target === 'default-status' ? '已恢复默认外观。' : '外观已保存。');
      } catch(e) { notify(target, e.message || '保存失败，请重试。'); }
    };
    get('saveAppearance').onclick = () => applyAppearance(appearanceValues());
    get('defaultAppearance').onclick = () => applyAppearance({ fontSize:17, popupWidth:640, transparency:0 }, 'default-status');
    preview();
    const save = () => {
      const values = Object.fromEntries(keys.map(key => [key, booleanKeys.has(key) ? get(key).checked : get(key).value]));
      api.save(values);
    };
    get('save').onclick = () => { try { save(); notify('save-status', '设置已保存。'); } catch(e) { notify('save-status', e.message || '保存失败，请重试。'); } };
    get('test').onclick = async () => {
      if (get('test').disabled) return;
      const button = get('test'), feedback = get('test-status');
      const label = button.textContent;
      window.clearTimeout(feedbackTimers.get('test-status'));
      feedbackTimers.delete('test-status');
      get('test').disabled = true;
      button.textContent = '正在测试…';
      feedback.textContent = '正在保存设置并连接翻译服务，请稍候…';
      feedback.setAttribute('aria-busy', 'true');
      try {
        save();
        const result = await api.translate('The researchers found that sleep improves memory.', { force: true });
        const mapped = result.segments.filter(s => s.source.includes(4)).map(s => s.text).join(' / ');
        // The sample uses memory only. Reader diagnostics and other articles'
        // cache writes are not part of testing the translation service.
        let details = '';
        try {
          const d = api.diagnostic();
          details = '\n已连接 PDF 视图：' + d.connectedPDFViews + (d.cache.error ? '\n' + d.cache.error : '');
        } catch (_) { /* Optional diagnostics must not turn success into failure. */ }
        notify('test-status', '连接成功：' + result.text + '\nsleep 对应：' + (mapped || '模型未提供映射') + details);
      } catch (e) {
        notify('test-status', '测试失败：' + (e.message || '请求未完成，请检查服务配置。'));
      } finally {
        updateUI(() => { button.disabled = false; button.textContent = label; feedback.removeAttribute('aria-busy'); });
      }
    };
    get('clear').onclick = async () => {
      if (get('clear').disabled) return;
      window.clearTimeout(feedbackTimers.get('clear-status'));
      get('clear-status').textContent = '正在清空…';
      get('clear').disabled = true;
      try { await api.reset(); notify('clear-status', '已清空已加载文章缓存。'); }
      catch(e) { notify('clear-status', e.message || '清空失败，请重试。'); }
      finally { updateUI(() => { get('clear').disabled = false; }); }
    };
    try {
      const cacheStatus = api.diagnostic().cache;
      if (cacheStatus.error) notify('clear-status', cacheStatus.error);
    } catch (_) { /* Opening preferences must not depend on reader diagnostics. */ }
    root.setAttribute('data-initialized', 'true');
  }
};
// Zotero dispatches load on the inserted pane fragment. Bind through capture
// as well as the inline handler, with an idempotent init for repeated loads.
document.addEventListener('load', event => {
  if (event.target?.id === 'sh-preferences') window.SHPrefs.init();
}, true);
