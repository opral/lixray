import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workflow = readFileSync(
  path.join(repositoryRoot, ".github/workflows/movie-benchmark.yml"),
  "utf8",
);

test("movie qualification requires an existing canonical Lix", () => {
  assert.match(workflow, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
	assert.match(workflow, /from public\.lixes where id/);
	assert.match(workflow, /deleted_at is null/);
  assert.match(workflow, /\.\[0\]\.exists == true/);
  assert.match(
    workflow,
    /--repository '\$\{\{ steps\.target\.outputs\.lix-id \}\}'/,
  );
  assert.doesNotMatch(workflow, /--workspace|inputs\.workspace/);
});
