"""Reproduce the explicitly staged recovery build; never deploys anything."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'work' / 'recovery-build'
BASE = '48cb0f8621e3a822cc65e0a7c23ba485ad3a574e'
SUPPORT = '8df8c12d47ed6334333088a8680c8998f9306bcc'


def blob(ref, name):
    return subprocess.check_output(['git', 'show', ref + ':' + name], cwd=ROOT)


def main():
    target = OUT / 'server'
    target.mkdir(parents=True, exist_ok=True)
    names = ['collector.js', 'admission.js', 'source-runtime.js', 'pump-pre.js',
             'pre-watcher.js', 'research-v2.js', 'research-runtime.js',
             'research-config.js', 'pass-runtime.js', 'research-two-runtime.js',
             'auto-research-v2.js', 'filter-audit.js']
    for name in names:
        (target / name).write_bytes(blob(BASE, 'server/' + name))
    (target / 'pre-watcher.js').write_bytes(blob(SUPPORT, 'server/pre-watcher.js'))
    resource = (ROOT / 'server/resource-budget.js').read_bytes().replace(b'\r\n', b'\n')
    (target / 'resource-budget.js').write_bytes(resource)
    (OUT / 'lab-core.js').write_bytes(blob(BASE, 'lab-core.js'))
    patch = (ROOT / 'deployment/recovery-48cb0f8-helius.patch').read_bytes().replace(b'\r\n', b'\n')
    subprocess.run(['git', 'apply', '--directory=work/recovery-build', '-'],
                   input=patch, cwd=ROOT, check=True)
    collector = target / 'collector.js'
    collector.write_bytes(collector.read_bytes().replace(b'\r\n', b'\n'))
    manifest = json.loads((ROOT / 'deployment/recovery-manifest.json').read_text())
    for name, expected in manifest['files'].items():
        actual = hashlib.sha256((target / name).read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError('Recovery hash mismatch: ' + name)
    print('Recovery build hashes verified:', target)


if __name__ == '__main__':
    main()
