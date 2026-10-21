import base64,hashlib,runpy,unittest,pathlib,copy
plan=runpy.run_path(str(pathlib.Path(__file__).with_name('publish-runtime.py')))['upload_plan']
class PublishTests(unittest.TestCase):
 def test_unchanged_does_not_restart(self):
  files={'collector.js':b'collector','helper.js':b'helper'};meta={n:{'md5_hash':base64.b64encode(hashlib.md5(b).digest()).decode()} for n,b in files.items()}
  self.assertEqual(plan(files,meta),[])
 def test_changed_module_requires_collector_last(self):
  files={'collector.js':b'collector','helper.js':b'helper'};meta={n:{'md5_hash':base64.b64encode(hashlib.md5(b).digest()).decode()} for n,b in files.items()};meta['helper.js']['md5_hash']='old'
  self.assertEqual(plan(files,meta),['helper.js','collector.js'])
 def test_new_module_uses_missing_generation_and_is_published_before_collector(self):
  files={'collector.js':b'collector','new.js':b'new'};meta={'collector.js':{'md5_hash':base64.b64encode(hashlib.md5(b'collector').digest()).decode()},'new.js':{'generation':'0','md5_hash':None}}
  self.assertEqual(plan(files,meta),['new.js','collector.js'])
class HealthTests(unittest.TestCase):
 def test_limits_and_partial_startup_are_enforced(self):
  check=runpy.run_path(str(pathlib.Path(__file__).with_name('check-runtime-health.py')))['health']
  sample={'publicFeeds':{'sourceAt':990000,'libraryAt':990000},'researchExports':{'oneAt':990000,'twoAt':990000},'updated':990000,'version':'v','mem':100,'memory':{'rssPeakMB':140},'resources':{'helius':{'creditsMinute':16}},'retention':{'stateBytes':10000000},'ws':{'connected':{'dbc':True,'ll':True}},**{k:{'active':True,'error':''} for k in ['source','passedV2','researchV2','researchTwo']}}
  self.assertTrue(check(sample,'v',1000)['okay'])
  for edit in [lambda x:x['publicFeeds'].update(sourceAt=1),lambda x:x['researchExports'].update(oneAt=1),lambda x:x.update(mem=451),lambda x:x['memory'].update(rssPeakMB=460),lambda x:x['resources']['helius'].update(creditsMinute=17.1),lambda x:x['retention'].update(stateBytes=31000000),lambda x:x['ws']['connected'].update(ll=False),lambda x:x['researchTwo'].update(active=False),lambda x:x.update(updated=1)]:
   bad=copy.deepcopy(sample);edit(bad);self.assertFalse(check(bad,'v',1000)['okay'])
class CheckpointRecoveryTests(unittest.TestCase):
 def fixture(self):
  import tempfile,json
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=pathlib.Path(tmp.name);(root/'deployment').mkdir()
  (root/'deployment/checkpoint-recovery-request.json').write_text(json.dumps({'id':'recovery-test','allowedFromGeneration':'123','maxWaitMs':1000,'maxStateBytes':10000}))
  (root/'deployment/recovery-manifest.json').write_text(json.dumps({'files':{'collector.js':'a'*64}}))
  (root/'deployment/recover-checkpoint.js').write_text('console.log(REQUEST.id);')
  return root
 def test_healthy_or_unrelated_generation_is_never_interrupted(self):
  dispatch=runpy.run_path(str(pathlib.Path(__file__).with_name('recover-checkpoint.py')))['dispatch'];root=self.fixture()
  def no_write(*args,**kwargs):raise AssertionError('Cloud write not allowed')
  self.assertEqual(dispatch(root,'bucket','456',no_write,lambda:{'version':'456'})['action'],'already-current')
  self.assertEqual(dispatch(root,'bucket','456',no_write,lambda:{'version':'789'})['action'],'other-generation-not-interrupted')
 def test_diagnostic_is_backed_up_and_replaced_with_a_generation_lease(self):
  import json
  dispatch=runpy.run_path(str(pathlib.Path(__file__).with_name('recover-checkpoint.py')))['dispatch'];root=self.fixture();calls=[];payload=[]
  def run(args,allow_missing=False):
   calls.append(args)
   if args[:3]==['storage','objects','describe']:return json.dumps({'generation':'77','md5_hash':'old'}) if args[3].endswith('/code/diag.js') else json.dumps({'generation':'88','md5_hash':'old'}) if any(x[:2]==['storage','cp'] for x in calls) else None
   if args[:2]==['storage','cp'] and not args[2].startswith('gs://'):payload.append(pathlib.Path(args[2]).read_text())
   return ''
  self.assertEqual(dispatch(root,'bucket','456',run,lambda:{'version':'123'})['action'],'checkpoint-recovery-dispatched')
  copies=[x for x in calls if x[:2]==['storage','cp']]
  self.assertIn('#77',copies[0][2]);self.assertIn('--if-generation-match=0',copies[0]);self.assertIn('--if-generation-match=77',copies[1])
  self.assertIn('"allowedFromGeneration":"123"',payload[0]);self.assertIn('generation=456',payload[0]);self.assertIn('"targetHash":"'+'a'*64+'"',payload[0])
 def test_disabled_recovery_does_not_even_read_runtime_or_write_cloud(self):
  import json
  dispatch=runpy.run_path(str(pathlib.Path(__file__).with_name('recover-checkpoint.py')))['dispatch'];root=self.fixture();p=root/'deployment/checkpoint-recovery-request.json';value=json.loads(p.read_text());value['enabled']=False;p.write_text(json.dumps(value))
  def refuse(*args,**kwargs):raise AssertionError('Disabled recovery must not access cloud')
  self.assertEqual(dispatch(root,'bucket','456',refuse,refuse)['action'],'disabled-request')
 def test_missing_diagnostic_channel_refuses_the_recovery(self):
  dispatch=runpy.run_path(str(pathlib.Path(__file__).with_name('recover-checkpoint.py')))['dispatch'];root=self.fixture()
  with self.assertRaisesRegex(RuntimeError,'Existing diagnostic channel'):dispatch(root,'bucket','456',lambda *args,**kwargs:None,lambda:{'version':'123'})
if __name__=='__main__':unittest.main()
