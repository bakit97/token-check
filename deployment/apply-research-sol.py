"""Apply only the owner's one-time 5 -> 0.5 SOL admission correction with leases."""
import json,pathlib,tempfile,time

def apply(root,bucket,run):
    request=json.loads((pathlib.Path(root)/'deployment/research-sol-request.json').read_text())
    if request.get('enabled') is False:return {'action':'disabled-request'}
    if request.get('id')!='owner-r1-sol05-20261026' or request.get('from')!=5 or request.get('to')!=.5:raise ValueError('Unreviewed SOL correction')
    if time.time()*1000>request['expiresAt']:return {'action':'expired-request'}
    marker='gs://'+bucket+'/config/applied-r1-sol05-20261026.json'
    if run(['storage','objects','describe',marker,'--format=value(generation)'],allow_missing=True):return {'action':'already-applied'}
    uri='gs://'+bucket+'/config/research-one.json';meta=json.loads(run(['storage','objects','describe',uri,'--format=json(generation)']));generation=str(meta['generation']);cfg=json.loads(run(['storage','cat',uri+'#'+generation]));targets=[cfg,*cfg.get('phases',{}).values()]
    for target in targets:
        quote=target.get('intake',{}).get('manual',{}).get('quoteSol')
        if quote is not None and quote.get('min') not in (5,.5):raise ValueError('SOL setting changed since owner request; preserve it')
    for target in targets:
        quote=target.get('intake',{}).get('manual',{}).get('quoteSol')
        if quote is not None:quote['min']=.5
    with tempfile.TemporaryDirectory() as folder:
        file=pathlib.Path(folder)/'config.json';file.write_text(json.dumps(cfg),encoding='utf-8');run(['storage','cp',str(file),uri,'--if-generation-match='+generation,'--quiet'])
        file.write_text(json.dumps({'schema':1,'id':request['id'],'appliedAt':int(time.time()*1000),'sol':.5}),encoding='utf-8');run(['storage','cp',str(file),marker,'--if-generation-match=0','--quiet'])
    print('Owner SOL admission correction applied; epoch and other thresholds preserved')
    return {'action':'applied'}
