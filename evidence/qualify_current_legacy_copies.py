"""Runs the detached current migrator only on explicitly cloned local stores."""
import json,pathlib,subprocess,time
root=pathlib.Path(__file__).parent
cohort=json.loads((root/'current-legacy-copy-cohort.json').read_text())
binary=pathlib.Path('/root/repos/lixray/vendor/lix/target/debug/examples/migrate_copy')
results=[]
for row in cohort['rows']:
 report=root/f"current-legacy-{row['physicalStorageId']}.json"
 start=time.monotonic()
 result=subprocess.run([str(binary),row['copy'],str(report),'--isolated-copy'],capture_output=True,text=True,timeout=300)
 (root/f"current-legacy-{row['physicalStorageId']}.log").write_text(result.stdout+result.stderr)
 item={**row,'exitCode':result.returncode,'seconds':round(time.monotonic()-start,2)}
 if report.exists(): item['report']=json.loads(report.read_text())
 else:item['diagnostic']=(result.stdout+result.stderr)[-2500:]
 results.append(item)
 (root/'current-legacy-cohort-results.json').write_text(json.dumps({'productionWrites':0,'results':results},indent=2)+'\n')
 print(json.dumps({k:v for k,v in item.items() if k!='report'}),flush=True)
