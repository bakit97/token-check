"""Publish only changed runtime files with generation leases, collector last."""
import argparse,base64,hashlib,json,pathlib,shutil,subprocess,re,runpy
ROOT=pathlib.Path(__file__).resolve().parents[1]
def upload_plan(files,metadata):
    changed=[name for name,body in files.items() if metadata[name].get('md5_hash')!=base64.b64encode(hashlib.md5(body).digest()).decode()]
    if changed and 'collector.js' not in changed:changed.append('collector.js')
    return [n for n in changed if n!='collector.js']+(['collector.js'] if changed else [])
def main():
    p=argparse.ArgumentParser();p.add_argument('--bucket',required=True);p.add_argument('--expected-generation');p.add_argument('--result');p.add_argument('--gcloud',default=shutil.which('gcloud') or shutil.which('gcloud.cmd'));a=p.parse_args()
    if not a.gcloud:raise RuntimeError('gcloud is unavailable')
    manifest=json.loads((ROOT/'deployment/recovery-manifest.json').read_text())
    files={name:(ROOT/'work/recovery-build/server'/name).read_bytes() for name in manifest['files']}
    for name,body in files.items():
        if hashlib.sha256(body).hexdigest()!=manifest['files'][name]:raise RuntimeError('Unverified build: '+name)
    def run(args,allow_missing=False):
        r=subprocess.run([a.gcloud,*args],capture_output=True,text=True)
        if r.returncode:
            if allow_missing and re.search(r'404|not found|does not exist|no urls matched',r.stderr,re.I):return None
            category=next((code for code in ['permission','forbidden','unauthorized','invalid choice','unrecognized arguments','not found','matched no objects','no urls matched','precondition','conditionnotmet','checksum','not have an active account','disabled','403','404','409','412'] if code in r.stderr.lower()),'unspecified')
            permissions=','.join(sorted(set(re.findall(r'compute\.[a-zA-Z.]+',r.stderr))))
            if permissions:category+=':'+permissions
            raise RuntimeError('Cloud operation failed: '+args[1]+' ['+category+'] (no credentials logged)')
        return r.stdout
    runpy.run_path(str(ROOT/'deployment/apply-research-epoch.py'))['apply'](ROOT,a.bucket,run)
    runpy.run_path(str(ROOT/'deployment/apply-research-sol.py'))['apply'](ROOT,a.bucket,run)
    runpy.run_path(str(ROOT/'deployment/apply-p45-module.py'))['apply'](ROOT,a.bucket,run)
    metadata={}
    for name in files:
        described=run(['storage','objects','describe','gs://'+a.bucket+'/code/'+name,'--format=json(generation,md5_hash)'],allow_missing=True)
        metadata[name]=json.loads(described) if described else {'generation':'0','md5_hash':None}
    before=str(metadata['collector.js']['generation'])
    if a.expected_generation and before!=a.expected_generation:raise RuntimeError('Collector generation changed; publication aborted')
    changed=upload_plan(files,metadata)
    for name in changed:
        run(['storage','cp',str(ROOT/'work/recovery-build/server'/name),'gs://'+a.bucket+'/code/'+name,'--if-generation-match='+str(metadata[name]['generation']),'--quiet'])
    generation=run(['storage','objects','describe','gs://'+a.bucket+'/code/collector.js','--format=value(generation)']).strip()
    result={'collectorGeneration':generation,'changed':changed,'unchanged':len(files)-len(changed)}
    if a.result:pathlib.Path(a.result).write_text(json.dumps(result),encoding='utf-8')
    runpy.run_path(str(ROOT/'deployment/recover-checkpoint.py'))['dispatch'](ROOT,a.bucket,generation,run)
    runpy.run_path(str(ROOT/'deployment/recover-vm.py'))['apply'](ROOT,a.bucket,generation,run)
    print(json.dumps(result))
if __name__=='__main__':main()
