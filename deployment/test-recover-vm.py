import unittest,runpy,tempfile,pathlib,json,time
apply=runpy.run_path('deployment/recover-vm.py')['apply']
class RecoveryTest(unittest.TestCase):
 def test_scope_checkpoint_and_current_version(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);(root/'deployment').mkdir();(root/'deployment/vm-reset-request.json').write_text(json.dumps({'id':'owner-stalled-solscan-20261026','enabled':True,'allowedFromGeneration':'1792636239831388','expiresAt':time.time()*1000+100000}));calls=[]
   def run(args,allow_missing=False):
    calls.append(args)
    if args[0:3]==['storage','objects','describe']:return None
    return 'RUNNING' if 'describe' in args else ''
   status={'version':'1792636239831388','memory':{'phases':{'save:complete':{'at':int(time.time()*1000)-1000,'rows':3}}},'retention':{'stateBytes':100}}
   self.assertEqual(apply(root,'bucket','999',run,lambda:status)['action'],'reset');self.assertTrue(any(c[:4]==['compute','instances','reset','solscan'] for c in calls))
   calls.clear();status['version']='999';self.assertEqual(apply(root,'bucket','999',run,lambda:status)['action'],'other-version-left-running');self.assertFalse(any('reset' in c for c in calls))
   status['version']='1792636239831388';status['memory']['phases']['save:complete']['at']=0
   with self.assertRaises(RuntimeError):apply(root,'bucket','999',run,lambda:status)
 def test_owner_accepts_old_complete_checkpoint(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);(root/'deployment').mkdir();(root/'deployment/vm-reset-request.json').write_text(json.dumps({'id':'owner-stalled-solscan-20261026','enabled':True,'allowedFromGeneration':'1792636239831388','expiresAt':time.time()*1000+100000,'ownerAcceptsCheckpointGap':True}));calls=[]
   def run(args,allow_missing=False):
    calls.append(args)
    return None if args[:3]==['storage','objects','describe'] else 'RUNNING' if 'describe' in args else ''
   status={'version':'1792636239831388','memory':{'phases':{'save:complete':{'at':int(time.time()*1000)-3600000,'rows':3}}},'retention':{'stateBytes':100}}
   self.assertEqual(apply(root,'bucket','999',run,lambda:status)['action'],'reset')
   status['memory']['phases']['save:complete']['rows']=0
   with self.assertRaises(RuntimeError):apply(root,'bucket','999',run,lambda:status)
 def test_oct31_scope_has_distinct_once_marker(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);(root/'deployment').mkdir();(root/'deployment/vm-reset-request.json').write_text(json.dumps({'id':'owner-stalled-solscan-20261031','enabled':True,'allowedFromGeneration':'1793365443116295','expiresAt':time.time()*1000+100000,'ownerAcceptsCheckpointGap':True}));calls=[]
   def run(args,allow_missing=False):
    calls.append(args);return None if args[:3]==['storage','objects','describe'] else ''
   status={'version':'1793365443116295','memory':{'phases':{'save:complete':{'at':time.time()*1000-3600000,'rows':4362}}},'retention':{'stateBytes':28220101}}
   self.assertEqual(apply(root,'bucket','1793443407688530',run,lambda:status)['action'],'reset')
   self.assertTrue(any('gs://bucket/config/applied-vm-recovery-20261031.json' in c for c in calls))
   self.assertEqual(sum(c[:4]==['compute','instances','reset','solscan']for c in calls),1)
   self.assertEqual(apply(root,'bucket','1793443407688530',lambda *a,**k:'exists',lambda:status)['action'],'already-applied')
if __name__=='__main__':unittest.main()
