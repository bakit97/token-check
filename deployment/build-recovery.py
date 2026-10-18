"""Build the single authoritative server source and verify its manifest."""
from pathlib import Path
import ast, hashlib, json, re
ROOT=Path(__file__).resolve().parents[1]
def runtime_names():
    source=(ROOT/'server/collector.js').read_text(encoding='utf-8')
    modules=ast.literal_eval(re.search(r"const MODULES=(\[[\s\S]*?\]);",source).group(1))
    names=['collector.js',*modules]
    if len(set(names))!=len(names) or any(not re.fullmatch(r'[a-z0-9-]+\.js',n) for n in names):
        raise RuntimeError('Invalid runtime module inventory')
    return names
def main():
    target=ROOT/'work/recovery-build/server';target.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((ROOT/'deployment/recovery-manifest.json').read_text())
    names=runtime_names()
    if set(names)!=set(manifest['files']):raise RuntimeError('Manifest inventory differs from collector modules')
    for name in names:
        body=(ROOT/'server'/name).read_bytes().replace(b'\r\n',b'\n')
        if hashlib.sha256(body).hexdigest()!=manifest['files'][name]:raise RuntimeError('Runtime hash mismatch: '+name)
        (target/name).write_bytes(body)
    print('Canonical runtime verified:',len(names),'files')
if __name__=='__main__':main()
