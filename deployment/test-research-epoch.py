import json,pathlib,runpy,tempfile,unittest
apply=runpy.run_path(str(pathlib.Path(__file__).with_name('apply-research-epoch.py')))['apply']
class EpochTests(unittest.TestCase):
 def test_apply_once_and_never_overwrite_a_later_owner_request(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);(root/'deployment').mkdir();(root/'deployment/research-epoch-request.json').write_text(json.dumps({'schema':1,'level':'one','id':'owner-p33-i1-20261021','issuedAt':1000}))
   state={'current':None,'writes':0}
   def run(args,allow_missing=False):
    if args[1:3]==['objects','describe']:return json.dumps({'generation':'123'}) if state['current'] else None
    if args[1]=='cat':return json.dumps(state['current'])
    self.assertIn('--if-generation-match=0',args);state['writes']+=1;state['current']=json.loads(pathlib.Path(args[2]).read_text());return ''
   apply(root,'test-bucket',run);apply(root,'test-bucket',run);self.assertEqual(state['writes'],1)
   state['current']={'id':'later-owner-action','requestedAt':2000};apply(root,'test-bucket',run);self.assertEqual(state['writes'],1)
if __name__=='__main__':unittest.main()
