"""Read-only, allowlisted startup fault counts. Never print raw serial output."""
import json,re,shutil,subprocess

def inspect(run=subprocess.run):
    cli=shutil.which('gcloud') or 'gcloud'
    args=[cli,'compute','instances','get-serial-port-output','solscan','--project=sol-scan-511718','--zone=us-central1-a','--port=1','--start=0']
    result=run(args,capture_output=True,text=True,timeout=40)
    if result.returncode:return {'serialAvailable':False,'reason':'permission-denied' if re.search('permission|forbidden|403',result.stderr,re.I) else 'read-unavailable'}
    patterns={'oom':r'Out of memory|oom-kill|heap out of memory|Killed process[^\n]*node','syntax':r'SyntaxError','missingModule':r'MODULE_NOT_FOUND|Cannot find module','invalidSnapshot':r'Invalid snapshot|Incomplete snapshot|Snapshot record exceeds','serviceFailure':r'solscan.service[^\n]*(?:failed|restart)','serviceStarted':r'Started[^\n]*(?:SOL.SCAN|solscan)'}
    return {'serialAvailable':True,'faultCounts':{key:len(re.findall(pattern,result.stdout[-32768:],re.I))for key,pattern in patterns.items()}}
if __name__=='__main__':
    try:print(json.dumps(inspect()))
    except (OSError,subprocess.TimeoutExpired):print(json.dumps({'serialAvailable':False,'reason':'read-unavailable'}))
