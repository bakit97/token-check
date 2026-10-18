"""Read public health only; never reads keys, metadata credentials or VM state."""
import argparse,json,time,urllib.request
p=argparse.ArgumentParser();p.add_argument('--bucket',required=True);p.add_argument('--generation',required=True);p.add_argument('--tries',type=int,default=1);a=p.parse_args()
for attempt in range(a.tries):
    try:
        with urllib.request.urlopen('https://storage.googleapis.com/'+a.bucket+'/status.json?t='+str(time.time_ns()),timeout=20) as r:s=json.load(r)
        age=time.time()-s['updated']/1000;credits=s['resources']['helius']['creditsMinute'];memory=s['mem'];ws=s['ws']['connected']
        okay=str(s['version'])==a.generation and age<120 and memory<450 and credits<=18 and ws.get('dbc') is True and ws.get('ll') is True and not s.get('source',{}).get('error')
        out={'okay':okay,'version':s['version'],'ageSec':round(age),'memoryMB':memory,'creditsMinute':credits,'dbc':ws.get('dbc'),'launchLab':ws.get('ll')}
        print(json.dumps(out),flush=True)
        if okay:raise SystemExit(0)
    except (OSError,KeyError,ValueError):print(json.dumps({'okay':False,'reason':'status unavailable or incomplete'}),flush=True)
    if attempt+1<a.tries:time.sleep(15)
raise SystemExit(1)
