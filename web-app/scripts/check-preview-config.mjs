import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const configPath = new URL("../dist/server/wrangler.json", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));

assert.equal(config.name, "lixray-preview");
assert.equal(config.preview_urls, true);
assert.equal(config.workers_dev, true);

for (const forbidden of ["containers", "routes", "route", "secrets"]) {
	assert.equal(
		config[forbidden],
		undefined,
		`Preview config must not contain ${forbidden}`,
	);
}

assert.deepEqual(config.durable_objects?.bindings ?? [], []);
assert.deepEqual(config.migrations ?? [], []);
assert.deepEqual(config.r2_buckets ?? [], []);
assert.deepEqual(config.vars ?? {}, {});

console.log("Preview Worker config is frontend-only and preview-enabled.");
