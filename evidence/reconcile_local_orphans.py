"""Synthetic-catalog qualification of preserved copies; NEVER resolves hosted identity or touches production."""
import os,json,pathlib,uuid,time,subprocess,concurrent.futures,boto3
from botocore.config import Config
root=pathlib.Path(__file__).parent
production=json.loads((root/'production-inventory.json').read_text()); copied=json.loads((root/'production-copy-qualification.json').read_text()); source=pathlib.Path(copied['destination']);manifest=json.loads((source/'copy-manifest.json').read_text())
records={r['key'].split('/')[-1][:-5]:r['record'] for r in production['catalog']};referenced={r['storage_id'] for r in records.values()}|{x for r in records.values() for x in r['retired']};physical={k.split('/')[0] for k in manifest if not k.startswith('.')};candidates=sorted(physical-referenced-set(copied['changedPrefixes']))
bucket='reconciliation-'+uuid.uuid4().hex[:12]
s3=boto3.client('s3',endpoint_url='http://127.0.0.1:19110',aws_access_key_id='lix-qualification',aws_secret_access_key='local-qualification-only',region_name='us-east-1',config=Config(max_pool_connections=24));s3.create_bucket(Bucket=bucket)
keys=[k for k in manifest if k.split('/')[0] in candidates]
def upload(key):s3.upload_file(str(source/key),bucket,key)
with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:list(pool.map(upload,keys))
for id in candidates:s3.put_object(Bucket=bucket,Key=f'.lix-repositories/{id}.json',Body=json.dumps({'state':'live','storage_id':id,'retired':[],'admission':None}))
base={k:v for k,v in os.environ.items() if not k.startswith(('S3_','OTEL_'))};base.update(S3_ENDPOINT='http://127.0.0.1:19110',S3_BUCKET=bucket,S3_ACCESS_KEY_ID='lix-qualification',S3_SECRET_ACCESS_KEY='local-qualification-only',S3_REGION='us-east-1',S3_ALLOW_HTTP='true',LIX_SERVER_INTERNAL_TOKEN='local-qualification-only',LIX_SERVER_PUBLIC_URL='http://127.0.0.1:19112',RUST_LOG='error')
binary='/root/repos/lixray/vendor/lix/target/debug/lix-server'
def qualify(id):
 start=time.monotonic();env={**base,'SLATEDB_CACHE_DIR':f'/tmp/lix-reconciliation-cache/{bucket}/{id}'}
 try:
  result=subprocess.run([binary,'upgrade-authority',id],env=env,capture_output=True,text=True,timeout=300);log=result.stdout+result.stderr;(root/f'local-orphan-{id}.log').write_text(log)
  row={'physicalStorageId':id,'exitCode':result.returncode,'seconds':round(time.monotonic()-start,2)}
  reports=s3.list_objects_v2(Bucket=bucket,Prefix=f'.lix-migration-reports/{id}/').get('Contents',[])
  if reports:row['migrationReport']=json.loads(s3.get_object(Bucket=bucket,Key=reports[-1]['Key'])['Body'].read())
  if result.returncode:row['diagnostic']=log[-1200:]
  return row
 except subprocess.TimeoutExpired:return {'physicalStorageId':id,'error':'qualification timed out; local source retained'}
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for row in pool.map(qualify,candidates):
  results.append(row);output={'localBucket':bucket,'syntheticCatalog':True,'hostedIdentityResolved':False,'productionWrites':0,'results':results};(root/'production-orphan-copy-qualification.json').write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({k:v for k,v in row.items() if k!='migrationReport'}),flush=True)
