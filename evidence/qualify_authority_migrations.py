"""Run detached migration on isolated local S3 copies only, never production."""
import os,json,pathlib,subprocess,concurrent.futures,time
root=pathlib.Path(__file__).parent; report=json.loads((root/'production-copy-qualification.json').read_text());inv=json.loads((root/'production-normalized-authority-inventory.json').read_text());excluded=set(report['changedPrefixes'])
base=os.environ.copy()
# Explicitly override all storage/auth/telemetry configuration for this local-only process.
base.update(S3_ENDPOINT='http://127.0.0.1:19110',S3_BUCKET='qualification',S3_ACCESS_KEY_ID='lix-qualification',S3_SECRET_ACCESS_KEY='local-qualification-only',S3_REGION='us-east-1',S3_ALLOW_HTTP='true',S3_PREFIX='',LIX_SERVER_INTERNAL_TOKEN='local-qualification-only',LIX_SERVER_PUBLIC_URL='http://127.0.0.1:19112',RUST_LOG='error')
base.pop('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',None)
base.pop('S3_PREFIX',None)
binary='/root/repos/lixray/vendor/lix/target/debug/lix-server'
entries=sorted((x for x in inv['entries'] if x['state']=='live' and x['storageId'] not in excluded),key=lambda x:x['objectBytes'])
def qualify(entry):
 id=entry['repositoryId'];env={**base,'SLATEDB_CACHE_DIR':f'/tmp/lix-qualification-cache/{id}'}; started=time.monotonic()
 try:
  result=subprocess.run([binary,'upgrade-authority',id],env=env,capture_output=True,text=True,timeout=300)
  (root/f'local-qualification-{id}.log').write_text(result.stdout+result.stderr)
  return {'repositoryId':id,'exitCode':result.returncode,'seconds':round(time.monotonic()-started,2)}
 except subprocess.TimeoutExpired:return {'repositoryId':id,'error':'qualification timeout; local candidate retained'}
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for result in pool.map(qualify,entries):
  results.append(result);(root/'production-migration-qualification-results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(result),flush=True)
print(json.dumps({'qualified':sum(x.get('exitCode')==0 for x in results),'attempted':len(results),'excludedUnstableSource':len(excluded),'productionWrites':0}),flush=True)
