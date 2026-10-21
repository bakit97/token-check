"""One-time recovery of one known checkpoint-starved collector generation."""
import hashlib,json,re,tempfile,time,urllib.request
from pathlib import Path

def dispatch(root,bucket,generation,run,read=None):
    root=Path(root);request_file=root/'deployment/checkpoint-recovery-request.json'
    if not request_file.exists():return {'action':'no-request'}
    request=json.loads(request_file.read_text(encoding='utf-8'))
    if not re.fullmatch(r'[a-z0-9-]{1,80}',request['id']) or not re.fullmatch(r'\d+',request['allowedFromGeneration']):raise ValueError('Invalid recovery scope')
    if request['maxWaitMs']>300000 or request['maxStateBytes']>32000000:raise ValueError('Invalid recovery bounds')
    if read is None:
        def read():
            with urllib.request.urlopen('https://storage.googleapis.com/'+bucket+'/status.json?recovery='+str(time.time_ns()),timeout=20) as r:return json.load(r)
    status=read()
    if str(status.get('version'))==str(generation):return {'action':'already-current'}
    if str(status.get('version'))!=request['allowedFromGeneration']:return {'action':'other-generation-not-interrupted'}
    manifest=json.loads((root/'deployment/recovery-manifest.json').read_text(encoding='utf-8'))
    request={**request,'targetHash':manifest['files']['collector.js'],'collectorUrl':'https://storage.googleapis.com/storage/v1/b/'+bucket+'/o/code%2Fcollector.js?alt=media&generation='+str(generation)}
    metadata=run(['storage','objects','describe','gs://'+bucket+'/code/diag.js','--format=json(generation,md5_hash)'],allow_missing=True)
    if metadata is None:raise RuntimeError('Existing diagnostic channel required; no interrupt requested')
    old=json.loads(metadata);old_generation=str(old['generation'])
    if not re.fullmatch(r'\d+',old_generation):raise ValueError('Invalid diagnostic generation')
    payload='"use strict";\nconst REQUEST='+json.dumps(request,separators=(',',':'))+';\n'+(root/'deployment/recover-checkpoint.js').read_text(encoding='utf-8')
    import base64
    digest=base64.b64encode(hashlib.md5(payload.encode()).digest()).decode()
    if old.get('md5_hash')==digest:return {'action':'same-recovery-already-dispatched','request':request['id']}
    if not old.get('md5_hash'):raise RuntimeError('Original diagnostic checksum unavailable')
    backup='gs://'+bucket+'/archive/diagnostics/diag-'+old_generation+'.js'
    copied=run(['storage','objects','describe',backup,'--format=json(generation,md5_hash)'],allow_missing=True)
    if copied is None:
        run(['storage','cp','gs://'+bucket+'/code/diag.js#'+old_generation,backup,'--if-generation-match=0','--quiet'])
        copied=run(['storage','objects','describe',backup,'--format=json(generation,md5_hash)'])
    if json.loads(copied).get('md5_hash')!=old['md5_hash']:raise RuntimeError('Diagnostic backup checksum mismatch; original left untouched')
    (root/'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='checkpoint-recovery-',dir=root/'work') as tmp:
        file=Path(tmp)/'diag.js';file.write_text(payload,encoding='utf-8')
        run(['storage','cp',str(file),'gs://'+bucket+'/code/diag.js','--if-generation-match='+old_generation,'--quiet'])
    result={'action':'checkpoint-recovery-dispatched','request':request['id'],'fromGeneration':request['allowedFromGeneration'],'targetGeneration':str(generation)}
    print(json.dumps(result));return result
