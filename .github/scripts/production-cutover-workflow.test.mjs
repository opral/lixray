import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const workflow=readFileSync(new URL('../workflows/production.yml',import.meta.url),'utf8');
function job(name){
 const start=workflow.indexOf(`\n  ${name}:\n`);
 assert.ok(start>=0,`missing ${name}`);
 return workflow.slice(start+1).split(/\n  [a-z][a-z0-9-]*:\n/)[0];
}
test('production promotion is opt-in and defaults to build-only',()=>{
 assert.match(workflow,/workflow_dispatch:\n    inputs:\n      promote:\n        description: [^\n]+\n        type: boolean\n        required: false\n        default: false/);
 for(const name of ['database','release']){
  const condition=job(name).match(/^    if: (.+)$/m)?.[1];
  assert.equal(condition,"github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.promote == true");
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
