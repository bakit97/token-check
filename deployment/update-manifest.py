"""Explicitly freeze hashes after editing canonical server/ sources."""
from pathlib import Path
import hashlib,json,runpy
root=Path(__file__).resolve().parents[1]
names=runpy.run_path(str(root/'deployment/build-recovery.py'))['runtime_names']()
manifest={'sourceDirectory':'server','files':{name:hashlib.sha256((root/'server'/name).read_bytes().replace(b'\r\n',b'\n')).hexdigest() for name in names}}
(root/'deployment/recovery-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print('Frozen canonical source hashes:',len(names))
