import unittest,runpy,tempfile,pathlib,json,time
apply=runpy.run_path('deployment/recover-vm.py')['apply']
class RecoveryTest(unittest.TestCase):
 def test_scope_checkpoint_and_current_version(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);(root/'deployment').mkdir();(root/'deployment/vm-reset-request.json').write_text(json.dumps({'id':'owner-stalled-solscan-20261026','enabled':True,'allowedFromGeneration':'1792636239831388','expiresAt':time.time()*1000+100000}));calls=[]
   def run(args,allow_missing=False):
    calls.append(args)
    if args[0:2]==['storage','cat']:return None
    return 'RUNNING' if 'describe' in args else ''
   status={'version':'1792636239831388','memory':{'phases':{'save:complete':{'at':int(time.time()*1000)-1000,'rows':3}}},'retention':{'stateBytes':100}}
   self.assertEqual(apply(root,'bucket','999',run,lambda:status)['action'],'reset');self.assertTrue(any(c[:4]==['compute','instances','reset','solscan'] for c in calls))
   calls.clear();status['version']='999';self.assertEqual(apply(root,'bucket','999',run,lambda:status)['action'],'other-version-left-running');self.assertFalse(any('reset' in c for c in calls))
   status['version']='1792636239831388';status['memory']['phases']['save:complete']['at']=0
   with self.assertRaises(RuntimeError):apply(root,'bucket','999',run,lambda:status)
if __name__=='__main__':unittest.main()
