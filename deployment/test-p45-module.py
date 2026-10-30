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

class RetirementTests(unittest.TestCase):
 def fixture(self,corrupt=False):
  import hashlib,base64
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=pathlib.Path(temp.name);(root/'deployment').mkdir();(root/'deployment/p45-module-request.json').write_text(json.dumps({'enabled':True,'id':'p45-retire-diagnostics-v1','expiresAt':9999999999999}));rules=[{'id':'p45-smoke-'+phase,'name':'P45 dex '+phase,'level':'1','phase':phase,'version':3,'conds':[{'key':'dex','op':'in','values':['PumpSwap','Raydium CPMM','Meteora DAMM v2']}]}for phase in ['before','after']];owner={'id':'owner','name':'Owner','level':'1','version':1,'conds':[{'key':'volume','op':'>=','value':5}]};cfg={'schema':1,'enabled':True,'activatedAt':123,'decisionMinutes':12,'filters':copy.deepcopy(rules)+[owner],'modules':[{'filterId':r['id'],'phase':r['phase'],'level':'1','enabled':True}for r in rules]+[{'filterId':'owner','phase':'after','level':'1','enabled':True}]};objects={'config/modules.json':json.dumps({'schema':1,'modules':rules+[owner],'deleted':[]}).encode(),'config/pass-filters.json':json.dumps(cfg).encode(),'research-v2/polygon-2.json':b'{"coins":[{"test":true}]}'};generations={k:'1'for k in objects};writes=[]
  def name(url):return url.removeprefix('gs://bucket/').split('#')[0]
  def run(args,allow_missing=False):
   if args[:3]==['storage','objects','describe']:
    n=name(args[3])
    if n not in objects:
     if allow_missing:return None
     raise AssertionError(n)
    return json.dumps({'generation':generations[n],'md5_hash':base64.b64encode(hashlib.md5(objects[n]).digest()).decode()})
   if args[:2]==['storage','cat']:return objects[name(args[2])].decode()
   if args[:2]==['storage','cp']:
    n=name(args[3]);match=next(x.split('=',1)[1]for x in args if x.startswith('--if-generation-match='));self.assertEqual(generations.get(n,'0'),match)
    if args[2].startswith('gs://'):
     objects[n]=objects[name(args[2])]+(b'x'if corrupt else b'')
    else:objects[n]=pathlib.Path(args[2]).read_bytes();writes.append(n)
    generations[n]=str(int(generations.get(n,'0'))+1);return ''
   raise AssertionError(args)
  return root,objects,writes,run,owner
 def test_verified_backup_then_retirement_preserves_owner_and_is_idempotent(self):
  root,objects,writes,run,owner=self.fixture();before=copy.deepcopy(objects);self.assertEqual(apply(root,'bucket',run)['action'],'diagnostics-retired');cfg=json.loads(objects['config/pass-filters.json']);self.assertEqual(cfg['filters'],[owner]);self.assertEqual(cfg['modules'],[{'filterId':'owner','phase':'after','level':'1','enabled':True}]);self.assertEqual(cfg['activatedAt'],123)
  for name,value in before.items():self.assertEqual(objects['archive/p45-smoke/snapshots/'+name.replace('/','_')+'-1.json'],value)
  self.assertEqual(apply(root,'bucket',run)['action'],'diagnostics-already-retired-or-owner-edited');self.assertEqual(len(writes),2)
 def test_archive_checksum_failure_keeps_both_original_configurations(self):
  root,objects,writes,run,_=self.fixture(True);before=copy.deepcopy(objects)
  with self.assertRaisesRegex(RuntimeError,'checksum mismatch'):apply(root,'bucket',run)
  self.assertEqual(objects['config/pass-filters.json'],before['config/pass-filters.json']);self.assertEqual(objects['config/modules.json'],before['config/modules.json']);self.assertFalse(writes)


class ChangingSnapshotTests(unittest.TestCase):
 fixture=RetirementTests.fixture
 def test_disappearing_source_generation_is_retried_with_a_fresh_verified_copy(self):
  root,objects,writes,run,_=self.fixture();fail=[True]
  def racing(args,allow_missing=False):
   if args[:2]==['storage','cp'] and args[2].startswith('gs://') and fail[0]:fail[0]=False;raise RuntimeError('source generation disappeared')
   return run(args,allow_missing)
  self.assertEqual(apply(root,'bucket',racing)['action'],'diagnostics-retired');self.assertEqual(len(writes),2)
 def test_failed_backup_is_not_ignored_when_all_attempts_fail(self):
  root,objects,writes,run,_=self.fixture();before=copy.deepcopy(objects)
  def racing(args,allow_missing=False):
   if args[:2]==['storage','cp'] and args[2].startswith('gs://'):raise RuntimeError('source unavailable')
   return run(args,allow_missing)
  with self.assertRaisesRegex(RuntimeError,'Verified diagnostic backup unavailable'):apply(root,'bucket',racing)
  self.assertEqual(objects['config/pass-filters.json'],before['config/pass-filters.json']);self.assertFalse(writes)

if __name__=='__main__':unittest.main()
