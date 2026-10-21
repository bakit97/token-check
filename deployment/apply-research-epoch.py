"""Apply the explicitly reviewed, idempotent epoch request; never touch settings."""
import json,tempfile,time,pathlib

def apply(root,bucket,run):
    request=json.loads((root/'deployment/research-epoch-request.json').read_text(encoding='utf-8'))
    if request.get('schema')!=1 or request.get('level') not in ('one','two') or request.get('id')!='owner-p33-i1-20261021':
        raise ValueError('Unreviewed epoch request')
    uri='gs://'+bucket+'/config/research-epoch-'+request['level']+'.json'
    meta=run(['storage','objects','describe',uri,'--format=json(generation)'],allow_missing=True)
    generation=str(json.loads(meta)['generation']) if meta else '0'
    current=json.loads(run(['storage','cat',uri])) if meta else None
    if current and (current.get('id')==request['id'] or current.get('requestedAt',0)>=request['issuedAt']):return
    body={'schema':1,'id':request['id'],'requestedAt':int(time.time()*1000)}
    with tempfile.TemporaryDirectory() as directory:
        file=pathlib.Path(directory)/'epoch.json';file.write_text(json.dumps(body),encoding='utf-8')
        run(['storage','cp',str(file),uri,'--if-generation-match='+generation,'--quiet'])
    print('Reviewed I1 epoch request applied; settings unchanged')
