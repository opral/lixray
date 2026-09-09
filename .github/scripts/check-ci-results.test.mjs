import assert from "node:assert/strict";
import test from "node:test";
import { checkCiResults } from "./check-ci-results.mjs";
const jobs = ["fast", "frontend", "sdk", "server-image", "web-image", "tooling", "database", "e2e", "sync"];
const fixture = (outputs = {}) => ({ changes: { result: "success", outputs }, ...Object.fromEntries(jobs.map(name => [name, {result:"skipped"}])) });
test("documentation changes need no images or browser suite", () => checkCiResults(fixture()));
test("selected integration jobs cannot silently skip, fail, or cancel", () => {
	for (const broken of ["sdk", "server-image", "web-image", "e2e", "sync"]) {
		for (const result of ["skipped", "failure", "cancelled"]) {
			const needs=fixture({e2e:"true"});
			for (const name of ["sdk", "server-image", "web-image", "e2e", "sync"]) needs[name].result="success";
			needs[broken].result=result;
			assert.throws(() => checkCiResults(needs), new RegExp(broken));
		}
	}
});
test("explicit previews require every artifact even for docs-only changes", () => assert.throws(() => checkCiResults(fixture(), true), /sdk/));
