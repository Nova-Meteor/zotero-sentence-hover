from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import hashlib
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
source = root
output = root / 'outputs'
output.mkdir(exist_ok=True)
manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
assert version
app = manifest['applications']['zotero']
for field in ('id', 'update_url', 'strict_max_version'):
    assert app.get(field), f'Missing required Zotero manifest field: {field}'
assert app['update_url'].startswith('https://')
ET.parse(source / 'prefs.xhtml')
runtime = ['manifest.json','bootstrap.js','core.js','cache.js','addon.js','prefs.xhtml','prefs.js','prefs.css','LICENSE']
xpi = output / f'sentence-hover-{version}.xpi'
with ZipFile(xpi, 'w', ZIP_DEFLATED) as z:
    for name in runtime:
        z.write(source / name, name)
with ZipFile(xpi) as z:
    assert z.testzip() is None
    assert set(z.namelist()) == set(runtime)
checksum = hashlib.sha256(xpi.read_bytes()).hexdigest()
(output / 'SHA256SUMS.txt').write_text(f'{checksum}  {xpi.name}' + chr(10), encoding='utf-8')
print(json.dumps({'xpi':str(xpi),'bytes':xpi.stat().st_size,'manifest':'valid','xhtml':'valid','archive':'valid'}, ensure_ascii=False))
