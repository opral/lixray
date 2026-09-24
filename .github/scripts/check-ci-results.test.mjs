import assert from "node:assert/strict";
import test from "node:test";
import { checkCiResults } from "./check-ci-results.mjs";
const jobs = ["fast", "frontend", "sdk", "server-image", "web-image", "tooling", "database", "e2e", "e2e-components", "sync"];
const fixture = (outputs = {}) => ({ changes: { result: "success", outputs }, ...Object.fromEntries(jobs.map(name => [name, {result:"skipped"}])) });
test("documentation changes need no images or browser suite", () => checkCiResults(fixture()));
test("selected integration jobs cannot silently skip, fail, or cancel", () => {
	for (const broken of ["sdk", "server-image", "web-image", "e2e", "e2e-components", "sync"]) {
		for (const result of ["skipped", "failure", "cancelled"]) {
			const needs=fixture({e2e:"true"});
			for (const name of ["sdk", "server-image", "web-image", "e2e", "e2e-components", "sync"]) needs[name].result="success";
			needs[broken].result=result;
			assert.throws(() => checkCiResults(needs), new RegExp(broken));
		}
	}
});
test("explicit previews require every artifact even for docs-only changes", () => assert.throws(() => checkCiResults(fixture(), true), /sdk/));

test("forks cannot silently bypass required integration or request a preview", () => {
  const needs = fixture({ frontend: "true", e2e: "true", tooling: "true", database: "true" });
  for (const name of ["fast", "frontend", "sdk", "tooling", "database"]) needs[name].result = "success";
  assert.throws(() => checkCiResults(needs, false, true), /Fork PR requires credential-dependent integration/);
  assert.throws(() => checkCiResults(fixture(), true, true), /Fork PR requires credential-dependent integration/);
  assert.throws(() => checkCiResults(needs, false, false), /server-image/);
  needs.changes.outputs.e2e = "false";
  checkCiResults(needs, false, true);
  for (const name of ["fast", "frontend", "sdk", "tooling", "database"]) {
    for (const result of ["skipped", "failure", "cancelled"]) {
      const broken = structuredClone(needs);
      broken[name].result = result;
      assert.throws(() => checkCiResults(broken, false, true), new RegExp(name));
    }
  }
  needs["web-image"].result = "failure";
  assert.throws(() => checkCiResults(needs, false, true), /web-image/);
});

test("static UI needs fast checks, not SDKs, images, or browsers", () => {
  const needs = fixture({ fast: "true", deploy: "true" });
  needs.fast.result = "success";
  checkCiResults(needs);
  for (const result of ["skipped", "failure", "cancelled"]) {
    needs.fast.result = result;
    assert.throws(() => checkCiResults(needs), /fast/);
  }
});

test("mixed UI and application changes still require full frontend checks", () => {
  const needs = fixture({ fast: "true", frontend: "true" });
  needs.fast.result = "success";
  assert.throws(() => checkCiResults(needs), /frontend/);
});
