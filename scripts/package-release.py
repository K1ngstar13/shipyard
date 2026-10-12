"""Every release contains its own double-click launchers and editing guide."""
from pathlib import Path
import json
import zipfile
root = Path(__file__).resolve().parents[1]
version = (root / 'VERSION').read_text().strip()
required = ['Start Shipyard.command', 'Start Shipyard.bat', 'START-HERE.html', 'scripts/start.mjs', 'docs/EDITING.md']
for name in required:
    if not (root / name).is_file():
        raise SystemExit('Missing required release file: ' + name)
assert json.loads((root / 'package.json').read_text())['version'] == version
assert f'<span class="ver">{version}</span>' in (root / 'site/index.html').read_text()
out = root.parents[1] / f'Shipyard-{version}.zip'
excluded = {'.git', 'node_modules', 'site-dist', 'build', 'release', '__pycache__'}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        relative = file.relative_to(root)
        if file.is_file() and not any(part in excluded for part in relative.parts) and not file.name.endswith('.tmp.mjs'):
            archive.write(file, Path('shipyard') / relative)
with zipfile.ZipFile(out) as archive:
    for name in required:
        assert 'shipyard/' + name in archive.namelist()
    assert (archive.getinfo('shipyard/Start Shipyard.command').external_attr >> 16) & 0o111
print(out)
