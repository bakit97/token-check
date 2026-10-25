import unittest,tempfile,pathlib,json,runpy,time
apply=runpy.run_path('deployment/apply-research-sol.py')['apply']
class ConfigTest(unittest.TestCase):
 def test_only_reviewed_sol_changes_with_generation_lease(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);(root/'deployment').mkdir();(root/'deployment/research-sol-request.json').write_text(json.dumps({'id':'owner-r1-sol05-20261026','from':5,'to':.5,'expiresAt':time.time()*1000+10000}));cfg={'minActive':60,'intake':{'manual':{'quoteSol':{'on':True,'min':5}}},'phases':{'after':{'minActive':20,'intake':{'manual':{'quoteSol':{'on':True,'min':5}}}}}};writes=[]
   def run(args,allow_missing=False):
    if args[1]=='cat':return None if 'applied-r1' in args[2] else json.dumps(cfg)
    if args[1]=='objects':return None if 'applied-r1' in args[3] else json.dumps({'generation':'123'})
    writes.append((args,json.loads(pathlib.Path(args[2]).read_text())));return ''
   self.assertEqual(apply(root,'bucket',run)['action'],'applied');body=writes[0][1];self.assertEqual(body['minActive'],60);self.assertEqual(body['phases']['after']['minActive'],20);self.assertEqual(body['intake']['manual']['quoteSol']['min'],.5);self.assertIn('--if-generation-match=123',writes[0][0]);self.assertIn('--if-generation-match=0',writes[1][0])
 def test_disabled_request_never_reads_or_changes_cloud(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);(root/'deployment').mkdir();(root/'deployment/research-sol-request.json').write_text(json.dumps({'enabled':False}))
   def run(*args,**kwargs):raise AssertionError('disabled cloud operation')
   self.assertEqual(apply(root,'bucket',run)['action'],'disabled-request')
if __name__=='__main__':unittest.main()
