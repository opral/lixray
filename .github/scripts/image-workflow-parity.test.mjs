import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const production = readFileSync(
	path.join(repositoryRoot, ".github/workflows/production.yml"),
	"utf8",
);
const pr = readFileSync(
	path.join(repositoryRoot, ".github/workflows/pr.yml"),
	"utf8",
);
const compose = readFileSync(path.join(repositoryRoot, "compose.yml"), "utf8");
const serverResolver = readFileSync(
	path.join(repositoryRoot, "scripts/resolve-lix-server.mjs"),
	"utf8",
);

const web = readFileSync(
  path.join(repositoryRoot, ".github/workflows/web-image.yml"), "utf8",
);
function job(workflow, name) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  return workflow.slice(start + 2).split(/\n  [a-z][a-z-]*:\n/)[0];
}

test("PR, production, and local development resolve the server from the Lix submodule", () => {
	for (const workflow of [pr, production]) {
		assert.match(
			workflow,
			/uses: \.\/\.github\/workflows\/lix-server-image\.yml/,
		);

	}
	assert.match(compose, /image: \$\{LIXRAY_SERVER_IMAGE:-/);
	assert.match(serverResolver, /git", \["-C", lixRoot, "rev-parse", "HEAD"\]/);
	assert.match(serverResolver, /lix-server:content-\$\{inputHash\}/);
	assert.match(serverResolver, /lix-server:sha-\$\{sourceRevision\}/);
	assert.match(serverResolver, /installServerImageArtifact/);
	assert.match(serverResolver, /SOURCE BUILD/);
});

test("PR and production use one exact-checkout web image builder", () => {
  for (const caller of [pr, production]) {
    assert.match(job(caller, "web-image"), /uses: \.\/\.github\/workflows\/web-image\.yml/);
    assert.doesNotMatch(caller, /file: web-app\/Dockerfile|web_inputs=|web_content_tag/);
  }
  assert.match(web, /submodules: recursive/);
  assert.match(web, /file: web-app\/Dockerfile/);
  assert.match(web, /RAILWAY_GIT_COMMIT_SHA=\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(web, /imagetools inspect|EXISTING_DIGEST|content_tag|tree_tag/);
});

test("shared web builds require the prepared SDK before Docker", () => {
  const download = web.indexOf("uses: actions/download-artifact@v4");
  const build = web.indexOf("uses: docker/build-push-action@v6");
  assert.ok(download >= 0 && download < build);
  assert.match(web.slice(download, build), /name: vendored-lix-sdk\n\s+path: \.lixray-ci\/vendored-lix-sdk/);
  assert.match(job(production, "web-image"), /needs: sdk/);
});

test("production validates and promotes the same immutable candidate before database changes", () => {
  const validate = job(production, "validate");
  assert.match(validate, /uses: \.\/\.github\/workflows\/browser-integration\.yml/);
  for (const name of ["web", "server"]) {
    const digest = `needs.${name}-image.outputs.image`;
    assert.ok(validate.includes(`${name}-image: ` + "${{ " + digest + " }}"));
    assert.ok(job(production, "release").includes(`${name.toUpperCase()}_IMAGE: ` + "${{ " + digest + " }}"));
  }
  assert.match(job(production, "database"), /needs: validate/);
  assert.match(job(production, "release"), /- validate/);
  const release = job(production, "release");
  assert.ok(release.indexOf("promote-production.sh") < release.indexOf("provision-production-canary.mjs"));
  assert.ok(release.indexOf("provision-production-canary.mjs") < release.indexOf("check-production-lix.mjs"));
});
