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
  sample={'updated':990000,'version':'v','mem':100,'memory':{'rssPeakMB':140},'resources':{'helius':{'creditsMinute':16}},'retention':{'stateBytes':10000000},'ws':{'connected':{'dbc':True,'ll':True}},**{k:{'active':True,'error':''} for k in ['source','passedV2','researchV2','researchTwo']}}
  self.assertTrue(check(sample,'v',1000)['okay'])
  for edit in [lambda x:x.update(mem=451),lambda x:x['memory'].update(rssPeakMB=460),lambda x:x['resources']['helius'].update(creditsMinute=17.1),lambda x:x['retention'].update(stateBytes=31000000),lambda x:x['ws']['connected'].update(ll=False),lambda x:x['researchTwo'].update(active=False),lambda x:x.update(updated=1)]:
   bad=copy.deepcopy(sample);edit(bad);self.assertFalse(check(bad,'v',1000)['okay'])
if __name__=='__main__':unittest.main()
