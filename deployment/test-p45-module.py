import copy,json,pathlib,runpy,tempfile,unittest
apply=runpy.run_path(str(pathlib.Path(__file__).with_name('apply-p45-module.py')))['apply']
class SmokeTests(unittest.TestCase):
 def fixture(self):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=pathlib.Path(temp.name);(root/'deployment').mkdir();(root/'deployment/p45-module-request.json').write_text(json.dumps({'enabled':True,'id':'p45-observational-module-v1','expiresAt':9999999999999}));return root
 def fake(self,owner=False):
  state={'pass-filters.json':{'schema':1,'enabled':True,'activatedAt':0,'decisionMinutes':15,'filters':[{'id':'owner'}] if owner else [],'modules':[]},'modules.json':{'schema':1,'modules':[],'deleted':[]},'research-one.json':{'decisionMinutes':12}};writes=[]
  def run(args,allow_missing=False):
   name=args[3].split('/')[-1] if args[:3]==['storage','objects','describe'] else None
   if name:return json.dumps({'generation':'1'}) if name in state else None
   if args[:2]==['storage','cat']:return json.dumps(state[args[2].split('/')[-1].split('#')[0]])
   if args[:2]==['storage','cp']:
    name=args[3].split('/')[-1];state[name]=json.loads(pathlib.Path(args[2]).read_text());writes.append(name);return ''
   raise AssertionError(args)
  return state,writes,run
 def test_only_empty_owner_configuration_is_populated_and_second_run_is_readonly(self):
  root=self.fixture();state,writes,run=self.fake();self.assertEqual(apply(root,'bucket',run)['action'],'applied');self.assertEqual(len(state['modules.json']['modules']),2);self.assertTrue(all(m['verdictMinutes']==12 for m in state['pass-filters.json']['filters']));self.assertEqual(len(writes),3);self.assertEqual(apply(root,'bucket',run)['action'],'already-applied');self.assertEqual(len(writes),3)
 def test_owner_modules_are_never_replaced(self):
  root=self.fixture();state,writes,run=self.fake(True);before=copy.deepcopy(state);self.assertEqual(apply(root,'bucket',run)['action'],'owner-rules-present-preserved');self.assertEqual(state,before);self.assertFalse(writes)
if __name__=='__main__':unittest.main()
