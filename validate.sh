#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo 'Node.js diperlukan untuk validasi JavaScript.' >&2; exit 1; }
python3 - <<'PY'
import json
from pathlib import Path
from collections import Counter
from lxml import html
import tinycss2

root = Path('.')
doc = html.fromstring((root / 'index.html').read_text(encoding='utf-8'))
ids = doc.xpath('//*[@id]/@id')
duplicates = [name for name, count in Counter(ids).items() if count > 1]
if duplicates:
    raise SystemExit('ID HTML duplikat: ' + ', '.join(duplicates))

missing = []
for node, attr in (('script', 'src'), ('link', 'href'), ('img', 'src')):
    for element in doc.xpath(f'//{node}[@{attr}]'):
        value = element.get(attr, '').strip()
        if not value or value.startswith(('http://', 'https://', 'data:', '#', 'mailto:')):
            continue
        if not (root / value).exists():
            missing.append(f'{node}:{value}')
if missing:
    raise SystemExit('Aset lokal tidak ditemukan: ' + ', '.join(missing))

manifest = json.loads((root / 'manifest.webmanifest').read_text(encoding='utf-8'))
for icon in manifest.get('icons', []):
    if not (root / icon['src'].removeprefix('./')).exists():
        raise SystemExit('Ikon manifest tidak ditemukan: ' + icon['src'])

css = tinycss2.parse_stylesheet((root / 'styles.css').read_text(encoding='utf-8'), skip_comments=True, skip_whitespace=True)
css_errors = [token for token in css if token.type == 'error']
if css_errors:
    raise SystemExit('CSS parse error: ' + '; '.join(error.message for error in css_errors))

js = (root / 'script.js').read_text(encoding='utf-8')
import re
selectors = set(re.findall(r"\$\(['\"]#([A-Za-z0-9_-]+)['\"]", js))
html_ids = set(ids)
missing_selectors = sorted(selectors - html_ids)
if missing_selectors:
    raise SystemExit('Selector ID JS tidak ditemukan di HTML: ' + ', '.join(missing_selectors))

required = ['backend-config.js', 'backend-client.js', 'backend/Code.gs', 'backend/SETUP.md', 'backend/tests/client-contract.test.js', 'service-worker.js']
for file in required:
    if not (root / file).is_file():
        raise SystemExit('Berkas penting tidak ditemukan: ' + file)

print(f'HTML: OK ({len(ids)} ID unik)')
print(f'Aset lokal dan ikon PWA: OK')
print(f'CSS: OK ({len(css)} node top-level)')
print(f'Selector ID JavaScript: OK ({len(selectors)} selector)')
print('Struktur backend dan PWA: OK')
PY

node --check script.js
node --check backend-client.js
node --check backend-config.js
node --check service-worker.js
node backend/tests/client-contract.test.js
cp backend/Code.gs /tmp/tagihanku-codegs-check.js
node --check /tmp/tagihanku-codegs-check.js
python3 -m json.tool backend/appsscript.json >/dev/null
python3 -m json.tool manifest.webmanifest >/dev/null

echo 'JavaScript, Apps Script syntax, manifest, dan JSON: OK'
echo 'VALIDASI TAGIHANKU: LULUS'
