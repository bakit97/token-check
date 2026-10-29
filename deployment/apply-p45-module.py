"""One-time observational P45 smoke modules, preserving all owner rules."""
import json,pathlib,tempfile,time

def apply(root,bucket,run):
    request=json.loads((pathlib.Path(root)/'deployment/p45-module-request.json').read_text(encoding='utf-8'))
    if not request.get('enabled') or time.time()*1000>request['expiresAt']:return {'action':'disabled-or-expired'}
    if request['id']=='p45-observational-module-v2':return adjust_safe(bucket,run)
    if request['id']!='p45-observational-module-v1':raise ValueError('Unknown smoke request')
    base='gs://'+bucket+'/config/';marker=base+'applied-p45-module.json'
    if run(['storage','objects','describe',marker,'--format=value(generation)'],allow_missing=True):return {'action':'already-applied'}
    def read(name,optional=False):
        meta=run(['storage','objects','describe',base+name,'--format=json(generation)'],allow_missing=optional)
        generation=str(json.loads(meta)['generation']) if meta else '0'
        return (json.loads(run(['storage','cat',base+name+'#'+generation])) if meta else {'schema':1,'modules':[],'deleted':[]}),generation
    cfg,lease=read('pass-filters.json');lib,libLease=read('modules.json',True);research,_=read('research-one.json')
    if cfg.get('filters') or cfg.get('modules') or lib.get('modules'):return {'action':'owner-rules-present-preserved'}
    now=int(time.time()*1000);filters=[];modules=[]
    for phase in ['before','after']:
        minute=research.get('phases',{}).get(phase,research).get('decisionMinutes',12);identifier='p45-smoke-'+phase
        item={'id':identifier,'level':'1','phase':phase,'name':'P45 SOL >= 0.5 '+phase,'verdictMinutes':minute,'conds':[{'key':'quoteSol','op':'>=','value':.5}],'version':1,'createdAt':now,'liveFrom':now}
        lib['modules'].append(item);filters.append(dict(item,key='quoteSol',op='>=',value=.5));modules.append({'filterId':identifier,'phase':phase,'level':'1','enabled':True})
    cfg.update(enabled=True,activatedAt=now,filters=filters,modules=modules)
    with tempfile.TemporaryDirectory() as folder:
        file=pathlib.Path(folder)/'config.json'
        for name,value,generation in [('modules.json',lib,libLease),('pass-filters.json',cfg,lease),('applied-p45-module.json',{'id':request['id'],'appliedAt':now,'moduleIds':[m['id'] for m in lib['modules']]},'0')]:
            file.write_text(json.dumps(value),encoding='utf-8');run(['storage','cp',str(file),base+name,'--if-generation-match='+generation,'--quiet'])
    print('P45 observational modules applied; no orders; owner rules preserved')
    return {'action':'applied'}


def adjust_safe(bucket,run):
    base='gs://'+bucket+'/config/';marker=base+'applied-p45-module-v2.json'
    if run(['storage','objects','describe',marker,'--format=value(generation)'],allow_missing=True):return {'action':'already-applied'}
    values={}
    for name in ['modules.json','pass-filters.json']:
        generation=str(json.loads(run(['storage','objects','describe',base+name,'--format=json(generation)']))['generation']);values[name]=(json.loads(run(['storage','cat',base+name+'#'+generation])),generation)
    ids={'p45-smoke-before','p45-smoke-after'}
    for name,(cfg,_) in values.items():
        rows=cfg['modules'] if name=='modules.json' else cfg['filters'];owned=[m for m in rows if m['id'] in ids]
        if len(owned)!=2 or any(m.get('conds')!=[{'key':'quoteSol','op':'>=','value':.5}] or m.get('version')!=1 for m in owned):return {'action':'owner-edits-preserved'}
    now=int(time.time()*1000)
    for name,(cfg,_) in values.items():
        for m in cfg['modules'] if name=='modules.json' else cfg['filters']:
            if m['id'] not in ids:continue
            m.update(name='P45 safe contract '+m['phase'],conds=[{'key':'safeContract','op':'>=','value':1}],version=2,liveFrom=now)
            if name=='pass-filters.json':m.update(key='safeContract',op='>=',value=1)
    with tempfile.TemporaryDirectory() as folder:
        file=pathlib.Path(folder)/'config.json'
        for name,(cfg,generation) in values.items():
            file.write_text(json.dumps(cfg),encoding='utf-8');run(['storage','cp',str(file),base+name,'--if-generation-match='+generation,'--quiet'])
        file.write_text(json.dumps({'id':'p45-observational-module-v2','appliedAt':now}),encoding='utf-8');run(['storage','cp',str(file),marker,'--if-generation-match=0','--quiet'])
    print('P45 smoke uses measured safeContract at N; owner modules preserved')
    return {'action':'applied-safe-contract'}
