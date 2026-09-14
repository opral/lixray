import json,subprocess,urllib.request,sys
secrets=json.loads(subprocess.check_output(['infisical','export','--env=prod','--format=json','--silent'],cwd='/root/repos/lixray'))
s={x['key']:x['value'] for x in secrets}
query=sys.argv[1]
req=urllib.request.Request('https://us.posthog.com/api/projects/'+s['POSTHOG_PROJECT_ID']+'/query/',data=json.dumps({'query':{'kind':'HogQLQuery','query':query}}).encode(),headers={'Authorization':'Bearer '+s['POSTHOG_API_KEY'],'Content-Type':'application/json'})
try:
 data=json.load(urllib.request.urlopen(req,timeout=90)); print(json.dumps({k:data.get(k) for k in ['columns','results','error']},indent=2))
except urllib.error.HTTPError as e: print(e.code,e.read().decode()[:1500])
