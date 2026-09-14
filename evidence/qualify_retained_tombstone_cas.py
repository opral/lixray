"""CAS conflict fault injection against a disposable LOCAL MinIO bucket only."""
import json,pathlib,uuid,boto3,os,subprocess,threading,time
root=pathlib.Path(__file__).parent
s3=boto3.client('s3',endpoint_url='http://127.0.0.1:19110',aws_access_key_id='lix-qualification',aws_secret_access_key='local-qualification-only',region_name='us-east-1')
f=json.loads((root/'local-tombstone-fixture.json').read_text());report=json.loads((root/'local-tombstone-initial.log').read_text());bucket='tombstone-cas-'+uuid.uuid4().hex[:10];s3.create_bucket(Bucket=bucket)
for page in s3.get_paginator('list_objects_v2').paginate(Bucket=f['bucket']):
 for o in page.get('Contents',[]):
  if o['Key'].startswith('.lix-retained-tombstones/'):continue
  s3.copy_object(Bucket=bucket,Key=o['Key'],CopySource={'Bucket':f['bucket'],'Key':o['Key']})
key=f".lix-repositories/{f['id']}.json";s3.put_object(Bucket=bucket,Key=key,Body=report['originalCatalog'].encode());changed=json.loads(report['originalCatalog']);changed['fingerprint']='concurrent-metadata-change'
injected=threading.Event();stop=threading.Event()
def inject():
 while not stop.is_set():
  if s3.list_objects_v2(Bucket=bucket,Prefix='.lix-retained-tombstones/').get('KeyCount',0):
   s3.put_object(Bucket=bucket,Key=key,Body=json.dumps(changed).encode());injected.set();return
  time.sleep(.001)
thread=threading.Thread(target=inject);thread.start()
env={k:v for k,v in os.environ.items() if not k.startswith(('S3_','OTEL_'))};env.update(S3_ENDPOINT='http://127.0.0.1:19110',S3_BUCKET=bucket,S3_ACCESS_KEY_ID='lix-qualification',S3_SECRET_ACCESS_KEY='local-qualification-only',S3_REGION='us-east-1',S3_ALLOW_HTTP='true',LIX_SERVER_INTERNAL_TOKEN='local-qualification-only',LIX_SERVER_PUBLIC_URL='http://127.0.0.1:19112',RUST_LOG='error')
try:
 with (root/'local-tombstone-cas.log').open('w') as out:p=subprocess.run(['/root/repos/lixray/vendor/lix/target/debug/lix-server','retain-tombstone',f['manifest']],env=env,stdout=out,stderr=subprocess.STDOUT)
finally:stop.set();thread.join()
actual=json.loads(s3.get_object(Bucket=bucket,Key=key)['Body'].read());log=(root/'local-tombstone-cas.log').read_text();result={'bucket':bucket,'injected':injected.is_set(),'exit':p.returncode,'casRejected':'CAS refused publication' in log,'concurrentCatalogPreserved':actual==changed,'productionWrites':0};(root/'local-tombstone-cas-results.json').write_text(json.dumps(result,indent=2)+'\n');print(result);assert result['injected'] and result['exit']!=0 and result['casRejected'] and result['concurrentCatalogPreserved']
