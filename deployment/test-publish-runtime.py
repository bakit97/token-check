import base64,hashlib,runpy,unittest,pathlib
plan=runpy.run_path(str(pathlib.Path(__file__).with_name('publish-runtime.py')))['upload_plan']
class PublishTests(unittest.TestCase):
 def test_unchanged_does_not_restart(self):
  files={'collector.js':b'collector','helper.js':b'helper'};meta={n:{'md5_hash':base64.b64encode(hashlib.md5(b).digest()).decode()} for n,b in files.items()}
  self.assertEqual(plan(files,meta),[])
 def test_changed_module_requires_collector_last(self):
  files={'collector.js':b'collector','helper.js':b'helper'};meta={n:{'md5_hash':base64.b64encode(hashlib.md5(b).digest()).decode()} for n,b in files.items()};meta['helper.js']['md5_hash']='old'
  self.assertEqual(plan(files,meta),['helper.js','collector.js'])
if __name__=='__main__':unittest.main()
