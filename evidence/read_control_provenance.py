"""Read-only repository provenance metadata; credentials remain in memory."""
import json,subprocess,urllib.request,pathlib
rows=json.loads(subprocess.check_output(['infisical','export','--env=prod','--path=/railway/lixray-web','--format=json','--silent'],cwd='/root/repos/lixray'))
secrets={r['key']:r['value'] for r in rows};url=secrets.get('SUPABASE_URL');key=secrets.get('SUPABASE_SERVICE_ROLE_KEY')
if not url or not key:raise RuntimeError('Web secret path lacks required Supabase connection fields')
out={}
for table,select in [('lixes','id,namespace_id,name,slug,created_at,updated_at,deleted_at'),('namespaces','id,created_at')]:
 request=urllib.request.Request(url.rstrip('/')+'/rest/v1/'+table+'?select='+select,headers={'Authorization':'Bearer '+key,'apikey':key,'Range':'0-9999'})
 with urllib.request.urlopen(request) as result:out[table]=json.load(result)
p=pathlib.Path(__file__).parent/'production-control-provenance.json';p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({name:len(rows) for name,rows in out.items()}))
