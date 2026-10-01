import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, readFile, readlink, writeFile } from "node:fs/promises";

// Disposable Linux loopback fixture only. Never discover/terminate arbitrary
// listeners: the caller supplies the PID file for the authority it owns.
const binary = process.env.PROTOTYPE_AUTHORITY_BINARY;
const pidFile = process.env.PROTOTYPE_AUTHORITY_PID_FILE;
assert.ok(binary?.startsWith("/"), "Supply an absolute fixture binary path");
assert.ok(
	pidFile?.startsWith("/tmp/"),
	"Supply the owned fixture /tmp PID file",
);
const pid = Number((await readFile(pidFile, "utf8")).trim());
assert.ok(Number.isSafeInteger(pid) && pid > 1);
const executable = await readlink(`/proc/${pid}/exe`);
assert.equal(
	executable,
	binary,
	"PID file does not identify the pinned fixture authority",
);
const environment = (await readFile(`/proc/${pid}/environ`, "utf8")).split(
	"\0",
);
assert.ok(
	environment.includes("BIND_ADDR=127.0.0.1:18309"),
	"PID does not own the fixture listener",
);
assert.ok(
	environment.includes("S3_PREFIX=native-prototype-01-10"),
	"PID does not own the disposable fixture prefix",
);
process.kill(pid, "SIGTERM");
const stopDeadline = Date.now() + 15_000;
while (Date.now() < stopDeadline) {
	try {
		const status = await readFile(`/proc/${pid}/status`, "utf8");
		if (/^State:\s+Z/m.test(status)) break;
	} catch (error) {
		if (error.code === "ENOENT") break;
		throw error;
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(Date.now() < stopDeadline, "Fixture authority did not stop cleanly");
const log = await open("/tmp/native-prototype-cold-authority.log", "a");
const child = spawn(binary, [], {
	detached: true,
	stdio: ["ignore", log.fd, log.fd],
	env: {
		...process.env,
		RUST_MIN_STACK: "16777216",
		S3_ACCESS_KEY_ID: "lixray",
		S3_SECRET_ACCESS_KEY: "lixray-local-secret",
		S3_REGION: "us-east-1",
		S3_BUCKET: "lixray",
		S3_PREFIX: "native-prototype-01-10",
		S3_ALLOW_HTTP: "true",
		S3_ENDPOINT: "http://127.0.0.1:53623",
		BIND_ADDR: "127.0.0.1:18309",
		LIX_SERVER_PUBLIC_URL: "http://127.0.0.1:8830",
		LIX_SERVER_INTERNAL_TOKEN: "lixray-local-internal-token",
	},
});
await new Promise((resolve, reject) => {
	child.once("spawn", resolve);
	child.once("error", reject);
});
await writeFile(pidFile, String(child.pid));
child.unref();
await log.close();
// Checking a non-repository route must not warm the measured repository.
const startDeadline = Date.now() + 15_000;
while (Date.now() < startDeadline) {
	try {
		const response = await fetch("http://127.0.0.1:18309/", {
			signal: AbortSignal.timeout(500),
		});
		assert.equal(response.status, 404, "Unexpected fixture root response");
		process.exit(0);
	} catch {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
throw new Error("Restarted fixture authority did not listen within 15 seconds");
