import json,pathlib,concurrent.futures,boto3
from botocore.config import Config
root=pathlib.Path(__file__).parent;report=json.loads((root/'production-copy-qualification.json').read_text());source=pathlib.Path(report['destination']);manifest=json.loads((source/'copy-manifest.json').read_text());excluded=set(report['changedPrefixes']); client=boto3.client('s3',endpoint_url='http://127.0.0.1:19110',aws_access_key_id='lix-qualification',aws_secret_access_key='local-qualification-only',region_name='us-east-1',config=Config(max_pool_connections=24));bucket='qualification'
client.create_bucket(Bucket=bucket)
def upload(key):
 if key.split('/')[0] in excluded:return False
 if key.startswith('.lix-repositories/'):
  record=json.loads((source/key).read_text())
  if record['storage_id'] in excluded:return False
 client.upload_file(str(source/key),bucket,key);return True
with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool: count=sum(pool.map(upload,manifest))
print(json.dumps({'uploadedObjects':count,'excludedChangedPrefixes':len(excluded),'productionWrites':0}))
