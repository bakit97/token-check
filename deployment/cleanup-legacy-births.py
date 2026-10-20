"""Owner TZ20: remove proven legacy births; preserve after byte offsets and generations."""
import argparse, gzip, json, pathlib, subprocess, tempfile, urllib.error, urllib.parse, urllib.request
BUCKET='sol-scan-511718-data'
BASE='https://storage.googleapis.com/'+BUCKET+'/'
API='https://storage.googleapis.com/storage/v1/b/'+BUCKET+'/o'
ROOT=pathlib.Path(__file__).resolve().parents[1]

def read(name):
    with urllib.request.urlopen(BASE+urllib.parse.quote(name,safe='/')+'?generation='+str(META[name]['generation']),timeout=90) as response:
        raw=response.read(512*1024*1024+1)
    if len(raw)>512*1024*1024: raise ValueError('Object exceeds cleanup bound')
    if raw[:2]==b'\x1f\x8b': raw=gzip.decompress(raw)
    return json.loads(raw)

def listing(prefix):
    result=[];cursor=None
    while True:
        query={'prefix':prefix,'maxResults':1000,'fields':'items(name,size,generation),nextPageToken'}
        if cursor: query['pageToken']=cursor
        with urllib.request.urlopen(API+'?'+urllib.parse.urlencode(query),timeout=45) as response: page=json.load(response)
        result+=page.get('items',[]);cursor=page.get('nextPageToken')
        if not cursor:return result

def main():
    global META
    p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--max-objects',type=int,default=0);a=p.parse_args()
    if a.apply and a.max_objects:raise ValueError('Partial apply is forbidden')
    prefixes=['source/day/','archive/legacy/day/','archive/legacy/obs/','archive/legacy/raw/','archive/legacy/research/','observations-v2/','research-v2/','passed-v2/']
    META={}
    for prefix in prefixes:
        entries=listing(prefix);META.update({x['name']:x for x in entries if x['name'].endswith('.json')});print(json.dumps({'listedPrefix':prefix,'objects':len(entries)}),flush=True)
    with urllib.request.urlopen(BASE+'status.json',timeout=30) as r: status=json.load(r)
    cutoff=status['poolTransition']['poolEpoch']['startedAt']
    if not isinstance(cutoff,int) or cutoff<=0:raise ValueError('No verified pool epoch')
    summary={'schema':1,'cutoff':cutoff,'scanned':0,'changed':0,'deleted':0,'removedRows':0,'redactedRows':0,'conflicts':0,'failed':0,'apply':a.apply}
    with tempfile.TemporaryDirectory() as tmp:
        tmp=pathlib.Path(tmp);input_file=tmp/'input.json';index_file=tmp/'index.json';output=tmp/'output.json'
        def transform(mode,value):
            input_file.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
            result=subprocess.run(['node',str(ROOT/'server/legacy-data-redaction.js'),mode,str(input_file),str(index_file),str(output)],capture_output=True)
            if result.returncode: raise ValueError('Transformation failed (object contents omitted)')
            return json.loads(output.read_text(encoding='utf-8'))
        index_file.write_text(json.dumps({'cutoff':cutoff}),encoding='utf-8')
        documents=[read(n) for n in META if n.startswith(('source/day/','archive/legacy/day/'))]
        index=transform('index',documents);print(json.dumps({'legacyPoolIdentities':len(index['before']),'protectedPoolIdentities':len(index['after'])}),flush=True);index_file.write_text(json.dumps(index),encoding='utf-8');del documents
        legacy_pools={key.split('|',1)[1] for key in index['before']}
        for name in sorted(META):
            if name.startswith('observations-v2/raw/') and name.rsplit('/',1)[-1].split('-',1)[0] not in legacy_pools:continue
            if a.max_objects and summary['scanned']>=a.max_objects:break
            # Source records are used to distinguish the same mint before/after.
            # Unknown identities remain present; no whole-prefix deletion.
            try:
                value=read(name);result=transform(name,value);summary['scanned']+=1
                counts=result['stats']
                if not counts['removed'] and not counts['redacted']:continue
                summary['removedRows']+=counts['removed'];summary['redactedRows']+=counts['redacted']
                body=result['value'];generation=str(META[name]['generation'])
                if a.apply:
                    target='gs://'+BUCKET+'/'+name
                    if body is None:args=['storage','rm',target,'--if-generation-match='+generation,'--quiet']
                    else:
                        compressed=tmp/'redacted.json.gz'
                        # Keep Node serialization for history rows: restore uses JSON.stringify offsets.
                        # Node output wraps value, so serialize the body with Node rather than Python.
                        extract=subprocess.run(['node','-e',"const fs=require('fs'),z=require('zlib');const x=JSON.parse(fs.readFileSync(process.argv[1]));fs.writeFileSync(process.argv[2],z.gzipSync(JSON.stringify(x.value)));",str(output),str(compressed)],capture_output=True)
                        if extract.returncode:raise ValueError('Encoding failed')
                        args=['storage','cp',str(compressed),target,'--if-generation-match='+generation,'--content-type=application/json','--content-encoding=gzip','--cache-control=no-cache,max-age=0','--quiet']
                    operation=subprocess.run(['gcloud',*args],capture_output=True,text=True)
                    if operation.returncode:
                        if '412' in operation.stderr or 'conditionNotMet' in operation.stderr:summary['conflicts']+=1;continue
                        raise ValueError('Generation-leased storage operation failed')
                if a.apply:
                    import base64,hashlib
                    metadata_url=API+'/'+urllib.parse.quote(name,safe='')+'?fields=generation,md5Hash'
                    try:
                        with urllib.request.urlopen(metadata_url,timeout=30) as r: verified=json.load(r)
                    except urllib.error.HTTPError as e:
                        if body is None and e.code==404:verified=None
                        else:raise
                    if body is None:
                        if verified is not None:raise ValueError('Deletion verification failed')
                    elif verified.get('md5Hash')!=base64.b64encode(hashlib.md5(compressed.read_bytes()).digest()).decode():raise ValueError('Upload verification failed')
                summary['deleted' if body is None else 'changed']+=1
            except Exception:
                summary['failed']+=1
            if summary['scanned']%10==0:print(json.dumps(summary),flush=True)
    summary['scanComplete']=not a.max_objects and not summary['failed'] and not summary['conflicts']
    pathlib.Path('legacy-cleanup-result.json').write_text(json.dumps(summary),encoding='utf-8');print(json.dumps(summary))
    if summary['failed']:raise SystemExit(1)
if __name__=='__main__':main()
