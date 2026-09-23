var shScope;
async function startup({ rootURI }, reason) {
  await Zotero.uiReadyPromise;
  shScope = { Zotero, Services, Components, IOUtils, PathUtils, URL: Zotero.getMainWindow().URL };
  Services.scriptloader.loadSubScript(rootURI + 'core.js', shScope, 'UTF-8');
  Services.scriptloader.loadSubScript(rootURI + 'cache.js', shScope, 'UTF-8');
  Services.scriptloader.loadSubScript(rootURI + 'addon.js', shScope, 'UTF-8');
  Zotero.SentenceHover = shScope.SentenceHover;
  await Zotero.PreferencePanes.register({
    pluginID: 'sentence-hover@local', id: 'sentence-hover-prefs',
    label: '句译随行', src: rootURI + 'prefs.xhtml', scripts: [rootURI + 'prefs.js'], stylesheets: [rootURI + 'prefs.css']
  });
  shScope.SentenceHover.start();
}
async function shutdown() {
  await shScope?.SentenceHover?.stop();
  delete Zotero.SentenceHover;
  shScope = null;
}
function install() {}
function uninstall() {}
