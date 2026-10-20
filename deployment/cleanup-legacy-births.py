"""Owner TZ20: remove proven legacy births; preserve after byte offsets and generations."""
import argparse, gzip, json, pathlib, subprocess, tempfile, time, urllib.error, urllib.parse, urllib.request
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

_token=None
_token_at=0
def mutation(method,url,data=None,headers=None):
    # Short-lived workflow identity only. Never print credentials or subprocess output.
    global _token,_token_at
    if not _token or time.time()-_token_at>2400:
        result=subprocess.run(['gcloud','auth','print-access-token'],capture_output=True,text=True)
        if result.returncode:raise ValueError('Workflow identity unavailable')
        _token=result.stdout.strip();_token_at=time.time()
    request=urllib.request.Request(url,data=data,method=method,headers={**(headers or {}),'Authorization':'Bearer '+_token})
    with urllib.request.urlopen(request,timeout=90) as response:response.read()

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
        index=transform('index',documents);print(json.dumps({'legacyPoolIdentities':len(index['before']),'protectedPoolIdentities':len(index['after'])}),flush=True);del documents
        manifest_name='maintenance/legacy-before-cleanup-index-v1.json'
        try:
            with urllib.request.urlopen(BASE+manifest_name,timeout=30) as r: saved=json.load(r)
        except urllib.error.HTTPError as e:
            if e.code!=404:raise
            saved=None
        if saved is not None:
            if saved.get('schema')!=1 or saved['index']['cutoff']!=cutoff:raise ValueError('Cleanup identity manifest mismatch')
            for key in ['before','after','events']:index[key]=sorted(set(index[key])|set(saved['index'][key]))
            index['before']=sorted(set(index['before'])-set(index['after']))
        elif a.apply:
            # Persist identities BEFORE erasing source/day or day files. A failed
            # job can then resume raw erasure without reconstructing deleted data.
            boundary='legacy-cleanup-index-v1'
            metadata=json.dumps({'name':manifest_name,'contentType':'application/json','cacheControl':'no-cache, max-age=0'}).encode()
            payload=json.dumps({'schema':1,'index':index},separators=(',',':')).encode()
            data=b'--'+boundary.encode()+b'\r\nContent-Type: application/json\r\n\r\n'+metadata+b'\r\n--'+boundary.encode()+b'\r\nContent-Type: application/json\r\n\r\n'+payload+b'\r\n--'+boundary.encode()+b'--\r\n'
            mutation('POST','https://storage.googleapis.com/upload/storage/v1/b/'+BUCKET+'/o?uploadType=multipart&ifGenerationMatch=0',data,{'Content-Type':'multipart/related; boundary='+boundary})
        index_file.write_text(json.dumps(index),encoding='utf-8')
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
                    if body is None:
                        mutation('DELETE',API+'/'+urllib.parse.quote(name,safe='')+'?ifGenerationMatch='+generation)
                    else:
                        compressed=tmp/'redacted.json.gz'
                        # Preserve Node's exact row serialization used by byte-offset references.
                        extract=subprocess.run(['node','-e',"const fs=require('fs'),z=require('zlib');const x=JSON.parse(fs.readFileSync(process.argv[1]));fs.writeFileSync(process.argv[2],z.gzipSync(JSON.stringify(x.value)));",str(output),str(compressed)],capture_output=True)
                        if extract.returncode:raise ValueError('Encoding failed')
                        boundary='legacy-birth-redaction-v1'
                        metadata=json.dumps({'name':name,'contentType':'application/json','contentEncoding':'gzip','cacheControl':'no-cache, max-age=0'}).encode()
                        data=b'--'+boundary.encode()+b'\r\nContent-Type: application/json\r\n\r\n'+metadata+b'\r\n--'+boundary.encode()+b'\r\nContent-Type: application/json\r\n\r\n'+compressed.read_bytes()+b'\r\n--'+boundary.encode()+b'--\r\n'
                        mutation('POST','https://storage.googleapis.com/upload/storage/v1/b/'+BUCKET+'/o?uploadType=multipart&ifGenerationMatch='+generation,data,{'Content-Type':'multipart/related; boundary='+boundary})
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
            except urllib.error.HTTPError as e:
                if e.code==412:summary['conflicts']+=1
                else:summary['failed']+=1
            except Exception:
                summary['failed']+=1
            if summary['scanned']%10==0:print(json.dumps(summary),flush=True)
    summary['scanComplete']=not a.max_objects and not summary['failed'] and not summary['conflicts']
    pathlib.Path('legacy-cleanup-result.json').write_text(json.dumps(summary),encoding='utf-8');print(json.dumps(summary))
    if summary['failed']:raise SystemExit(1)
if __name__=='__main__':main()
