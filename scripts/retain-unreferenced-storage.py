"""Retain explicitly classified nonlive storage with an exact content manifest.

Requires boto3 and blake3. Uses standard AWS credentials plus S3_ENDPOINT,
S3_BUCKET and an explicit S3_PREFIX. No objects are moved or deleted. The plan
contains controlPlaneDigest and entries of {storageId, reason}; obtain it from
reviewed control-plane reconciliation. Run with all writers/restarts stopped.
Default mode writes local reviewable manifests; --publish performs create-only
manifest publication after re-verifying all source bytes.
"""
import argparse
import json
import os
from pathlib import Path
from uuid import UUID

import blake3
import boto3


def inventory(client, bucket, prefix):
    return {
        obj['Key']: (obj['Size'], obj['ETag'], obj['LastModified'].isoformat())
        for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix)
        for obj in page.get('Contents', [])
    }


def digest_object(client, bucket, key):
    response = client.get_object(Bucket=bucket, Key=key)
    digest = blake3.blake3()
    try:
        for chunk in response['Body'].iter_chunks(chunk_size=1024 * 1024):
            digest.update(chunk)
    finally:
        response['Body'].close()
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plan', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--control-inventory', required=True, type=Path)
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--writers-stopped', action='store_true')
    args = parser.parse_args()
    if args.publish and not args.writers_stopped:
        parser.error('publication requires the external writer/restart barrier')
    plan = json.loads(args.plan.read_text())
    digest = plan['controlPlaneDigest']
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('invalid control-plane digest')
    control_bytes = args.control_inventory.read_bytes()
    if blake3.blake3(control_bytes).hexdigest() != digest:
        raise ValueError('control-plane inventory does not match the reviewed plan')
    control = json.loads(control_bytes)
    if isinstance(control, dict):
        control = control['lixes']
    live_ids = {row['id'] for row in control if row['deleted_at'] is None}
    entries = plan['entries']
    ids = [entry['storageId'] for entry in entries]
    if len(ids) != len(set(ids)):
        raise ValueError('duplicate storage IDs')
    bucket = os.environ['S3_BUCKET']
    prefix = os.environ['S3_PREFIX'].strip('/') + '/'
    if prefix == '/':
        raise ValueError('explicit nonempty S3_PREFIX required')
    client = boto3.client('s3', endpoint_url=os.environ.get('S3_ENDPOINT'))
    args.output.mkdir(parents=True, exist_ok=True)
    # A physical source referenced by any catalog is never quarantined.
    referenced = set()
    for key in inventory(client, bucket, prefix + '.lix-repositories/'):
        raw = client.get_object(Bucket=bucket, Key=key)['Body'].read()
        record = json.loads(raw)
        referenced.add(record['storage_id'] if 'storage_id' in record else record['storageId'])
        referenced.update(record.get('retired', []))
    for entry in entries:
        storage_id = entry['storageId']
        if str(UUID(storage_id)) != storage_id or storage_id in referenced or storage_id in live_ids:
            raise ValueError('invalid or catalogued quarantine source')
        if not entry['reason'].strip():
            raise ValueError('explicit provenance disposition is required')
        source = prefix + storage_id + '/'
        before = inventory(client, bucket, source)
        if not before:
            raise ValueError('missing physical source')
        objects = [dict(key=key[len(source):], bytes=meta[0], blake3=digest_object(client, bucket, key))
                   for key, meta in sorted(before.items())]
        if before != inventory(client, bucket, source):
            raise ValueError('source changed during manifest capture')
        manifest = dict(storageId=storage_id, reason=entry['reason'], controlPlaneDigest=digest, objects=objects)
        payload = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
        (args.output / (storage_id + '.json')).write_bytes(payload)
        if args.publish:
            for obj in objects:
                if digest_object(client, bucket, source + obj['key']) != obj['blake3']:
                    raise ValueError('source changed before publication')
            if before != inventory(client, bucket, source):
                raise ValueError('source inventory changed before publication')
            client.put_object(Bucket=bucket, Key=prefix + '.lix-quarantine/' + storage_id + '.json',
                              Body=payload, ContentType='application/json', IfNoneMatch='*')
    print(json.dumps(dict(manifests=len(entries), published=args.publish, sourcesRetained=True)))


if __name__ == '__main__':
    main()
