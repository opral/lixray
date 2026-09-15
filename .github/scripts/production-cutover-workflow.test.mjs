import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const workflow=readFileSync(new URL('../workflows/production.yml',import.meta.url),'utf8');
function job(name){
 const start=workflow.indexOf(`\n  ${name}:\n`);
 assert.ok(start>=0,`missing ${name}`);
 return workflow.slice(start+1).split(/\n  [a-z][a-z0-9-]*:\n/)[0];
}
test('main pushes and manual runs promote after validation',()=>{
 assert.match(workflow,/workflow_dispatch:/);
 assert.doesNotMatch(workflow,/inputs\.promote/);
 for(const name of ['database','release']){
  const condition=job(name).match(/^    if: (.+)$/m)?.[1];
  assert.equal(condition,"github.ref == 'refs/heads/main'");
 }
});
test('ordinary pushes retain the matched image build and validation graph',()=>{
 assert.match(workflow,/push:\n    branches:\n      - main/);
 for(const name of ['server-image','sdk','web-image','validate']){
  assert.doesNotMatch(job(name),/inputs\.promote|needs:.*database|needs:.*release/);
 }
 assert.match(job('web-image'),/needs: sdk/);
 assert.match(job('validate'),/needs:\n      - web-image\n      - server-image/);
 assert.match(job('database'),/needs: validate/);
 assert.match(job('release'),/needs:\n      - database\n      - validate\n      - web-image\n      - server-image/);
});
