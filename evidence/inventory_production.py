import subprocess,json,boto3,pathlib,collections
root=pathlib.Path(__file__).parent
raw=json.loads(subprocess.check_output(['infisical','export','--env=prod','--path=/railway/lix-server','--format=json','--silent'],cwd='/root/repos/lixray'))
s={x['key']:x['value'] for x in raw}
client=boto3.client('s3',endpoint_url=s['S3_ENDPOINT'],aws_access_key_id=s['S3_ACCESS_KEY_ID'],aws_secret_access_key=s['S3_SECRET_ACCESS_KEY'],region_name=s.get('S3_REGION','auto'))
counts=collections.Counter(); catalog=[]
for page in client.get_paginator('list_objects_v2').paginate(Bucket=s['S3_BUCKET']):
 for obj in page.get('Contents',[]):
  key=obj['Key']; counts[key.split('/')[0]]+=1
  if '/.lix-repositories/' in key or key.startswith('.lix-repositories/'):
   item={'key':key,'bytes':obj['Size']}
   try:
    record=json.loads(client.get_object(Bucket=s['S3_BUCKET'],Key=key)['Body'].read())
    item['record']={k:record.get(k) for k in ['state','storage_id','retired','admission']}
   except Exception as error: item['error']=type(error).__name__
   catalog.append(item)
result={'catalog':catalog,'topLevelObjectCounts':dict(counts)}
(root/'production-inventory.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'catalogRecords':len(catalog),'catalogStates':dict(collections.Counter(x.get('record',{}).get('state','invalid') for x in catalog)),'topLevelPrefixes':len(counts),'totalObjects':sum(counts.values())}))
