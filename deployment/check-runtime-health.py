"""Read public health only; never reads keys, credentials or VM state."""
import argparse,json,time,urllib.request
def health(s,generation,now):
    age=now-s['updated']/1000;credits=s['resources']['helius']['creditsMinute'];memory=s['mem'];ws=s['ws']['connected'];state=s['retention']['stateBytes'];peak=s.get('memory',{}).get('rssPeakMB',memory)
    modules=all(s.get(k,{}).get('active') is True and not s.get(k,{}).get('error') and not s.get(k,{}).get('configError') for k in ['source','passedV2','researchV2','researchTwo'])
    okay=str(s['version'])==generation and age<120 and memory<450 and peak<450 and state<30000000 and credits<=18 and ws.get('dbc') is True and ws.get('ll') is True and modules
    return {'okay':okay,'version':s['version'],'ageSec':round(age),'memoryMB':memory,'peakMB':peak,'stateBytes':state,'creditsMinute':credits,'dbc':ws.get('dbc'),'launchLab':ws.get('ll'),'modulesReady':modules}
def main():
    p=argparse.ArgumentParser();p.add_argument('--bucket',required=True);p.add_argument('--generation',required=True);p.add_argument('--tries',type=int,default=1);a=p.parse_args()
    for attempt in range(a.tries):
        try:
            with urllib.request.urlopen('https://storage.googleapis.com/'+a.bucket+'/status.json?t='+str(time.time_ns()),timeout=20) as r:s=json.load(r)
            result=health(s,a.generation,time.time());print(json.dumps(result),flush=True)
            if result['okay']:return 0
        except (OSError,KeyError,ValueError):print(json.dumps({'okay':False,'reason':'status unavailable or incomplete'}),flush=True)
        if attempt+1<a.tries:time.sleep(15)
    return 1
if __name__=='__main__':raise SystemExit(main())
