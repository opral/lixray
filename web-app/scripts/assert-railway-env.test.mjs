import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = new URL("./assert-railway-env.mjs", import.meta.url);

test("accepts demo mode in a Railway PR environment", () => {
	for (const name of ["lixray-pr-91", "pr-11b179-85"]) {
		const result = runAssert({
			RAILWAY_ENVIRONMENT_NAME: name,
			LIXRAY_DEMO: "1",
			VITE_LIXRAY_DEMO: "1",
		});
		assert.equal(result.status, 0, `${name}: ${result.stderr}`);
	}
});

test("rejects demo mode outside a Railway PR environment", () => {
	const result = runAssert({
		RAILWAY_ENVIRONMENT_NAME: "production",
		LIXRAY_DEMO: "1",
		VITE_LIXRAY_DEMO: "1",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /only supported in Railway PR environments/);
});

function runAssert(extraEnv) {
	return spawnSync(process.execPath, [fileURLToPath(script)], {
		env: { ...process.env, ...extraEnv },
		encoding: "utf8",
	});
}
