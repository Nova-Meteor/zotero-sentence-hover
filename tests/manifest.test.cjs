const {test} = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../manifest.json');
test('Zotero 10 installation requires ID, update URL and max version', () => {
  const app = manifest.applications.zotero;
  for (const key of ['id', 'update_url', 'strict_max_version']) assert.ok(app[key], key);
  assert.match(app.id, /^[a-z0-9._-]*@[a-z0-9._-]+$/i);
  assert.equal(new URL(app.update_url).protocol, 'https:');
  assert.equal(app.strict_min_version, '10.0');
  assert.equal(app.strict_max_version, '10.*');
  assert.equal(manifest.version, require('../package.json').version);
});
