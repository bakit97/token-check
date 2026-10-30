"""One-time observational P45 smoke modules, preserving all owner rules."""
import json,pathlib,tempfile,time

def apply(root,bucket,run):
    request=json.loads((pathlib.Path(root)/'deployment/p45-module-request.json').read_text(encoding='utf-8'))
    if not request.get('enabled') or time.time()*1000>request['expiresAt']:return {'action':'disabled-or-expired'}
    if request['id']=='p45-retire-diagnostics-v1':return retire(bucket,run)
    if request['id'] in ['p45-observational-module-v2','p45-observational-module-v3']:return adjust_safe(bucket,run,3 if request['id'].endswith('v3') else 2)
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


def adjust_safe(bucket,run,version=2):
    condition={'key':'quoteSol','op':'>=','value':.5} if version==2 else {'key':'safeContract','op':'>=','value':1}
    replacement={'key':'safeContract','op':'>=','value':1} if version==2 else {'key':'dex','op':'in','values':['Meteora DAMM v2','PumpSwap','Raydium CPMM']}
    base='gs://'+bucket+'/config/';marker=base+'applied-p45-module-v'+str(version)+'.json'
    if run(['storage','objects','describe',marker,'--format=value(generation)'],allow_missing=True):return {'action':'already-applied'}
    values={}
    for name in ['modules.json','pass-filters.json']:
        generation=str(json.loads(run(['storage','objects','describe',base+name,'--format=json(generation)']))['generation']);values[name]=(json.loads(run(['storage','cat',base+name+'#'+generation])),generation)
    ids={'p45-smoke-before','p45-smoke-after'}
    for name,(cfg,_) in values.items():
        rows=cfg['modules'] if name=='modules.json' else cfg['filters'];owned=[m for m in rows if m['id'] in ids]
        if len(owned)!=2 or any(m.get('conds')!=[condition] or m.get('version')!=version-1 for m in owned):return {'action':'owner-edits-preserved'}
    now=int(time.time()*1000)
    for name,(cfg,_) in values.items():
        for m in cfg['modules'] if name=='modules.json' else cfg['filters']:
            if m['id'] not in ids:continue
            m.update(name='P45 '+replacement['key']+' '+m['phase'],conds=[replacement],version=version,liveFrom=now)
            if name=='pass-filters.json':m.update(**replacement)
    with tempfile.TemporaryDirectory() as folder:
        file=pathlib.Path(folder)/'config.json'
        for name,(cfg,generation) in values.items():
            file.write_text(json.dumps(cfg),encoding='utf-8');run(['storage','cp',str(file),base+name,'--if-generation-match='+generation,'--quiet'])
        file.write_text(json.dumps({'id':'p45-observational-module-v'+str(version),'appliedAt':now}),encoding='utf-8');run(['storage','cp',str(file),marker,'--if-generation-match=0','--quiet'])
    print('P45 smoke uses measured '+replacement['key']+' at N; owner modules preserved')
    return {'action':'applied-safe-contract' if version==2 else 'applied-dex'}


def owned_diagnostic(rule):
    if rule.get('id') not in ['p45-smoke-before','p45-smoke-after'] or rule.get('level')!='1' or not rule.get('name','').startswith('P45 '):return False
    conds=rule.get('conds') or [{k:rule[k] for k in ['key','op','value','values'] if k in rule}]+rule.get('conditions',[])
    if len(conds)!=1:return False
    c=conds[0];version=rule.get('version')
    return version==1 and c=={'key':'quoteSol','op':'>=','value':.5} or version==2 and c=={'key':'safeContract','op':'>=','value':1} or version==3 and c.get('key')=='dex' and c.get('op')=='in' and sorted(c.get('values',[]))==sorted(['Meteora DAMM v2','PumpSwap','Raydium CPMM'])

def retire(bucket,run):
    base='gs://'+bucket+'/';values={}
    for name in ['modules.json','pass-filters.json']:
        meta=json.loads(run(['storage','objects','describe',base+'config/'+name,'--format=json(generation,md5_hash)']))
        values[name]=(json.loads(run(['storage','cat',base+'config/'+name+'#'+str(meta['generation'])])),meta)
    all_rules=values['modules.json'][0].get('modules',[])+values['pass-filters.json'][0].get('filters',[])
    ids={r['id'] for r in all_rules if owned_diagnostic(r)}
    ids={i for i in ids if all(owned_diagnostic(r) for r in all_rules if r.get('id')==i)}
    if not ids:return {'action':'diagnostics-already-retired-or-owner-edited'}
    # Views can be replaced while a pinned generation is being copied. Retry a
    # fresh immutable generation; never relax destination CAS or checksum checks.
    for name in ['config/modules.json','config/pass-filters.json','passed-v2/day/2026-10-29.json','passed-v2/day/2026-10-30.json','research-v2/polygon-2.json','research-v2/status-two.json']:
        verified=False
        for attempt in range(4):
            raw=run(['storage','objects','describe',base+name,'--format=json(generation,md5_hash)'],allow_missing=True)
            if raw is None:verified=True;break
            meta=json.loads(raw);generation=str(meta['generation']);checksum=meta.get('md5_hash')
            if not checksum:raise RuntimeError('Diagnostic snapshot checksum unavailable; originals preserved')
            dest=base+'archive/p45-smoke/snapshots/'+name.replace('/','_')+'-'+generation+'.json'
            old=run(['storage','objects','describe',dest,'--format=json(generation,md5_hash)'],allow_missing=True)
            copy_error=None
            if old is None:
                try:run(['storage','cp',base+name+'#'+generation,dest,'--if-generation-match=0','--quiet'])
                except RuntimeError as error:copy_error=error
            saved=run(['storage','objects','describe',dest,'--format=json(generation,md5_hash)'],allow_missing=True)
            if saved is not None:
                if json.loads(saved).get('md5_hash')!=checksum:raise RuntimeError('Diagnostic archive checksum mismatch; originals preserved')
                verified=True;break
            if attempt==3:raise RuntimeError('Verified diagnostic backup unavailable for '+name+'; '+str(copy_error or 'copy missing'))
            print(json.dumps({'diagnosticSnapshot':name,'action':'retry-changed-generation','attempt':attempt+1}))
        if not verified:raise RuntimeError('Diagnostic backup not verified; originals preserved')
    with tempfile.TemporaryDirectory() as folder:
        file=pathlib.Path(folder)/'config.json'
        for name,(cfg,meta) in values.items():
            key='modules' if name=='modules.json' else 'filters';cfg[key]=[r for r in cfg.get(key,[]) if r.get('id') not in ids]
            if name=='pass-filters.json':cfg['modules']=[r for r in cfg.get('modules',[]) if r.get('filterId') not in ids]
            file.write_text(json.dumps(cfg),encoding='utf-8');run(['storage','cp',str(file),base+'config/'+name,'--if-generation-match='+str(meta['generation']),'--quiet'])
    return {'action':'diagnostics-retired','ids':sorted(ids),'ownerRulesPreserved':True,'archive':'archive/p45-smoke/'}
