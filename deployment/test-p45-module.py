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
 def test_v2_changes_only_our_original_smoke_rules_and_is_idempotent(self):
  root=self.fixture();state,writes,run=self.fake();apply(root,'bucket',run)
  owner={'id':'owner-extra','name':'Owner','conds':[{'key':'volume','op':'>=','value':5}]};state['modules.json']['modules'].append(copy.deepcopy(owner));state['pass-filters.json']['filters'].append(copy.deepcopy(owner))
  file=root/'deployment/p45-module-request.json';request=json.loads(file.read_text());request['id']='p45-observational-module-v2';file.write_text(json.dumps(request));self.assertEqual(apply(root,'bucket',run)['action'],'applied-safe-contract');self.assertEqual(state['modules.json']['modules'][-1],owner);self.assertEqual(state['pass-filters.json']['filters'][-1],owner);self.assertEqual(state['modules.json']['modules'][0]['conds'],[{'key':'safeContract','op':'>=','value':1}]);self.assertEqual(apply(root,'bucket',run)['action'],'already-applied')
 def test_v2_preserves_owner_edit_of_a_smoke_rule(self):
  root=self.fixture();state,writes,run=self.fake();apply(root,'bucket',run);state['modules.json']['modules'][0]['conds'][0]['value']=9
  file=root/'deployment/p45-module-request.json';request=json.loads(file.read_text());request['id']='p45-observational-module-v2';file.write_text(json.dumps(request));before=copy.deepcopy(state);self.assertEqual(apply(root,'bucket',run)['action'],'owner-edits-preserved');self.assertEqual(state,before)
 def test_v3_uses_proven_dex_without_changing_minute_or_owner_rules(self):
  root=self.fixture();state,writes,run=self.fake();apply(root,'bucket',run);file=root/'deployment/p45-module-request.json';request=json.loads(file.read_text());request['id']='p45-observational-module-v2';file.write_text(json.dumps(request));apply(root,'bucket',run);request['id']='p45-observational-module-v3';file.write_text(json.dumps(request));self.assertEqual(apply(root,'bucket',run)['action'],'applied-dex');module=state['modules.json']['modules'][0];self.assertEqual(module['verdictMinutes'],12);self.assertEqual(module['conds'][0]['key'],'dex');self.assertEqual(module['version'],3)
if __name__=='__main__':unittest.main()
