"""One reviewed VM restart if the old process cannot consume its diagnostic channel."""
import json,pathlib,tempfile,time,urllib.request

def apply(root,bucket,target,run,read=None):
    p=pathlib.Path(root)/'deployment/vm-reset-request.json'
    if not p.exists():return {'action':'no-request'}
    req=json.loads(p.read_text())
    if not req.get('enabled'):return {'action':'disabled'}
    reviewed={'owner-stalled-solscan-20261026':('1792636239831388','20261026'),'owner-stalled-solscan-20261031':('1793365443116295','20261031')}
    scope_request=reviewed.get(req.get('id'))
    if not scope_request or req.get('allowedFromGeneration')!=scope_request[0]:raise ValueError('Unreviewed VM reset')
    if time.time()*1000>req['expiresAt']:return {'action':'expired'}
    marker='gs://'+bucket+'/config/applied-vm-recovery-'+scope_request[1]+'.json'
    if run(['storage','objects','describe',marker,'--format=value(generation)'],allow_missing=True):return {'action':'already-applied'}
    if read is None:
        def read():
            with urllib.request.urlopen('https://storage.googleapis.com/'+bucket+'/status.json?x='+str(time.time_ns()),timeout=20) as response:return json.load(response)
    s=read()
    if str(s.get('version'))!=req['allowedFromGeneration']:return {'action':'other-version-left-running'}
    completed=s.get('memory',{}).get('phases',{}).get('save:complete',{});age=time.time()*1000-completed.get('at',0)
    if not (age>=0 and (age<=1800000 or req.get('ownerAcceptsCheckpointGap') is True)) or not completed.get('rows',0)>0 or not 0<s.get('retention',{}).get('stateBytes',0)<=64000000:raise RuntimeError('No owner-accepted complete bounded checkpoint; VM left running')
    if str(target)==req['allowedFromGeneration']:raise ValueError('New runtime required before reset')
    scope=['--project=sol-scan-511718','--zone=us-central1-a']
    # Compute reset itself rejects a VM that is not running; do not require
    # separate read privileges in addition to the owner-authorized operation.
    run(['compute','instances','reset','solscan',*scope,'--quiet'])
    with tempfile.TemporaryDirectory() as folder:
        file=pathlib.Path(folder)/'receipt.json';file.write_text(json.dumps({'id':req['id'],'action':'reset-after-completed-checkpoint','checkpointAgeMs':int(age),'targetGeneration':str(target),'at':int(time.time()*1000)}));run(['storage','cp',str(file),marker,'--if-generation-match=0','--quiet'])
    print(json.dumps({'action':'reviewed-stalled-vm-reset','checkpointAgeMs':int(age),'targetGeneration':str(target)}));return {'action':'reset'}
