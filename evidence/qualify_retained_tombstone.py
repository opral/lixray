"""Local MinIO only. Copies an already qualified local catalog and both retained source trees."""
import json,pathlib,uuid,boto3,blake3
from botocore.config import Config
root=pathlib.Path(__file__).parent
s3=boto3.client('s3',endpoint_url='http://127.0.0.1:19110',aws_access_key_id='lix-qualification',aws_secret_access_key='local-qualification-only',region_name='us-east-1',config=Config(max_pool_connections=12))
fixtures=json.loads((root/'local-adoption-fixtures.json').read_text());source_bucket=fixtures['localBucket'];bucket='tombstone-proof-'+uuid.uuid4().hex[:10];s3.create_bucket(Bucket=bucket)
id=next(row['hostedId'] for row in fixtures['fixtures'] if row['sourceFormat']==77);key=f'.lix-repositories/{id}.json';catalog=s3.get_object(Bucket=source_bucket,Key=key)['Body'].read();record=json.loads(catalog);s3.put_object(Bucket=bucket,Key=key,Body=catalog)
sources=[]
for storage in [record['storage_id'],*record['retired']]:
 entries=[]
 for page in s3.get_paginator('list_objects_v2').paginate(Bucket=source_bucket,Prefix=storage+'/'):
  for obj in page.get('Contents',[]):
   body=s3.get_object(Bucket=source_bucket,Key=obj['Key'])['Body'].read();s3.put_object(Bucket=bucket,Key=obj['Key'],Body=body)
   entries.append({'key':obj['Key'][len(storage)+1:],'bytes':len(body),'blake3':blake3.blake3(body).hexdigest()})
 sources.append({'storageId':storage,'objects':sorted(entries,key=lambda x:x['key'])})
control=json.dumps([{'id':id,'deleted_at':'2026-09-09T23:31:49Z'}],indent=2).encode();(root/'local-tombstone-control.json').write_bytes(control)
manifest={'schemaVersion':1,'hostedRepositoryId':id,'controlInventoryPath':'local-tombstone-control.json','controlInventoryBlake3':blake3.blake3(control).hexdigest(),'controlDeletedAt':'2026-09-09T23:31:49Z','catalogBlake3':blake3.blake3(catalog).hexdigest(),'physicalSources':sources}
(root/'local-tombstone-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(root/'local-tombstone-fixture.json').write_text(json.dumps({'bucket':bucket,'id':id,'manifest':str(root/'local-tombstone-manifest.json'),'productionWrites':0},indent=2)+'\n');print(bucket)
