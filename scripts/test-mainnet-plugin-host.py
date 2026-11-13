#!/usr/bin/env python3
"""Read-only host check of the packaged Mainnet bridge. Requires the original App running.

Never calls purchase/recovery, changes authority, or edits daily Codex configuration.
"""
from pathlib import Path
import os,json,subprocess,shutil,importlib.util,hashlib,sqlite3
root=Path(__file__).resolve().parents[1];state=root/'build.noindex/mainnet-plugin/host-final'
for n in ['codex-home','user-home','workspace']:(state/n).mkdir(parents=True,exist_ok=True,mode=0o700)
env={'PATH':os.environ['PATH'],'HOME':str(state/'user-home'),'CODEX_HOME':str(state/'codex-home'),'NO_COLOR':'1'}
codex=shutil.which('codex')
for command in [['plugin','marketplace','add',str(root/'build.noindex/mainnet-plugin/marketplace'),'--json'],['plugin','add','yosh-mainnet@yosh-mainnet-local','--json']]:
 r=subprocess.run([codex,*command],env=env,capture_output=True,timeout=90)
 if r.returncode:raise RuntimeError('PRIVATE_PLUGIN_INSTALL_FAILED')
spec=importlib.util.spec_from_file_location('host',root/'scripts/accept-codex-plugin-dev.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
database=Path.home()/'Library/Application Support/Yosh Pay Dev v0.1.1-rc.5/Mainnet/app-ledger.sqlite'
def fingerprint():
 c=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)
 try:return {t:hashlib.sha256(json.dumps(c.execute('select * from '+t+' order by 1').fetchall(),sort_keys=True).encode()).hexdigest() for t in ['purchases','spend_grants','original_payments','resource_registry','wallet_accounts','monetary_controls']}
 finally:c.close()
before=fingerprint();checks=[]
for iteration in range(2):
 h=m.Host(codex,env,state/'workspace')
 try:
  h.call('initialize',{'clientInfo':{'name':'yosh_mainnet_attach_check','version':'1'},'capabilities':{'experimentalApi':True}});h.send({'method':'initialized','params':{}})
  tid=h.call('thread/start',{'cwd':str(state/'workspace'),'sandbox':'read-only','approvalPolicy':'on-request','ephemeral':True})['thread']['id']
  inv=h.call('mcpServerStatus/list',{'threadId':tid,'detail':'toolsAndAuthOnly'})
  servers=[s for s in inv['data'] if 'get_spending_status' in s.get('tools',{})]
  if len(servers)!=1:
   print([{'name':s.get('name'),'toolsError':s.get('toolsError'),'tools':list(s.get('tools',{}))} for s in inv['data']]);raise RuntimeError('EXACT_MAINNET_SERVER_REQUIRED')
  s=servers[0];result=h.call('mcpServer/tool/call',{'threadId':tid,'server':s['name'],'tool':'get_spending_status','arguments':{}})
  if result.get('isError'):raise RuntimeError('STATUS_FAILED')
  d=json.loads(result['content'][0]['text'])
  # Existing wrapper can nest status. Persist only bounded public facts.
  checks.append({'iteration':iteration,'tools':sorted(s['tools']),'statusFacts':m.summarize(result)})
 finally:h.close()
after=fingerprint();assert before==after
record={'host':'real Codex app-server, private CODEX_HOME','pluginInstalledFromPackage':True,'checks':checks,'authorityRowsUnchanged':before==after,'paymentCalls':0,'backendRestarted':False,'desktopAcceptance':False}
(state/'evidence.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'checks':len(checks),'tools':checks[0]['tools'],'authorityRowsUnchanged':before==after,'paymentCalls':0},ensure_ascii=False))
