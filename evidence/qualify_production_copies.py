"""Read-only production snapshot for local qualification. Never opens remote storage or writes S3."""
import concurrent.futures, hashlib, json, pathlib, subprocess, uuid
import boto3
from botocore.config import Config
root=pathlib.Path(__file__).parent
raw=json.loads(subprocess.check_output(['infisical','export','--env=prod','--path=/railway/lix-server','--format=json','--silent'],cwd='/root/repos/lixray'))
secrets={x['key']:x['value'] for x in raw}
client=boto3.client('s3',endpoint_url=secrets['S3_ENDPOINT'],aws_access_key_id=secrets['S3_ACCESS_KEY_ID'],aws_secret_access_key=secrets['S3_SECRET_ACCESS_KEY'],region_name=secrets.get('S3_REGION','auto'),config=Config(max_pool_connections=24,retries={'max_attempts':3}))
bucket=secrets['S3_BUCKET']; prefix='railway/277aebe4-e179-4809-984b-e5d49381372f/'
destination=pathlib.Path('/tmp/lix-fleet-qualification')/str(uuid.uuid4()); destination.mkdir(parents=True)
def listed():
 return {o['Key']:{'etag':o['ETag'],'bytes':o['Size']} for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket,Prefix=prefix) for o in page.get('Contents',[])}
initial=listed()
def copy(item):
 key,meta=item; relative=key[len(prefix):]; target=destination/relative
 target.parent.mkdir(parents=True,exist_ok=True)
 response=client.get_object(Bucket=bucket,Key=key,IfMatch=meta['etag']); digest=hashlib.sha256(); size=0
 with target.open('wb') as output:
  for chunk in response['Body'].iter_chunks(1024*1024):output.write(chunk);digest.update(chunk);size+=len(chunk)
 if size!=meta['bytes']:raise RuntimeError('Source size changed')
 return relative,{**meta,'sha256':digest.hexdigest()}
manifest={}; failures=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
 futures={pool.submit(copy,item):item[0] for item in initial.items()}
 for future in concurrent.futures.as_completed(futures):
  try:key,result=future.result();manifest[key]=result
  except Exception as error:failures.append({'key':futures[future][len(prefix):],'error':type(error).__name__})
final=listed(); changed=sorted({key[len(prefix):].split('/')[0] for key in set(initial)|set(final) if initial.get(key)!=final.get(key)})
report={'destination':str(destination),'objects':len(manifest),'bytes':sum(x['bytes'] for x in manifest.values()),'changedPrefixes':changed,'failures':failures,'qualificationOnly':True,'warning':'Only unchanged prefixes with no failed object reads are candidates for qualification; production still requires an exclusive backup.'}
(destination/'copy-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(root/'production-copy-qualification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
