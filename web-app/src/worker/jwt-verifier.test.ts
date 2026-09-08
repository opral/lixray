import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { errors } from "jose";
import {
	classifyJwtVerifyError,
	loadPersistedJwksCache,
	persistJwksCache,
	getRemoteJwks,
	persistRemoteJwksIfPresent,
	resetRemoteJwksForTests,
	warmRemoteJwks,
} from "./jwt-verifier.ts";

void test("JWKS fetch and network failures are not invalid tokens", () => {
	assert.equal(
		classifyJwtVerifyError(new errors.JWKSTimeout()),
		"jwks_unavailable",
	);
	assert.equal(
		classifyJwtVerifyError(
			new errors.JOSEError(
				"Expected 200 OK from the JSON Web Key Set HTTP response",
			),
		),
		"jwks_unavailable",
	);
	assert.equal(
		classifyJwtVerifyError(new TypeError("fetch failed")),
		"jwks_unavailable",
	);
	assert.equal(
		classifyJwtVerifyError(
			Object.assign(new Error("connect ECONNREFUSED"), {}),
		),
		"jwks_unavailable",
	);
});

void test("signature and claim failures stay invalid_token", () => {
	assert.equal(
		classifyJwtVerifyError(new errors.JWSSignatureVerificationFailed()),
		"invalid_token",
	);
	assert.equal(
		classifyJwtVerifyError(new errors.JWTExpired("JWT expired", {})),
		"invalid_token",
	);
	assert.equal(
		classifyJwtVerifyError(new errors.JWKSNoMatchingKey()),
		"invalid_token",
	);
});

void test("JWKS cache round-trips a persisted snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lixray-jwks-"));
	const cachePath = join(directory, "jwks-cache.json");
	try {
		assert.deepEqual(await loadPersistedJwksCache(cachePath), {});
		const snapshot = {
			uat: Date.now(),
			jwks: { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] },
		};
		await persistJwksCache(cachePath, snapshot);
		assert.deepEqual(await loadPersistedJwksCache(cachePath), snapshot);
		assert.match(await readFile(cachePath, "utf8"), /"keys"/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

void test("concurrent rotated snapshots persist in order with atomic replacement", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "lixray-jwks-race-"));
	const cachePath = join(directory, "cache.json");
	const oldKeys = { keys: [{ kty: "EC", kid: "old" }] };
	const newKeys = {
		keys: [
			{ kty: "EC", kid: "new" },
			{ kty: "EC", kid: "second" },
		],
	};
	let servedKeys = oldKeys;
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(servedKeys));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}/jwks`;
	let releaseWrite!: () => void;
	const writeGate = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	let firstWriteStarted!: () => void;
	const firstWrite = new Promise<void>((resolve) => {
		firstWriteStarted = resolve;
	});
	const mkdirSpy = t.mock.method(fs, "mkdir");
	const writeFile = fs.writeFile.bind(fs);
	let writes = 0;
	t.mock.method(
		fs,
		"writeFile",
		async (...args: Parameters<typeof fs.writeFile>) => {
			writes++;
			if (writes === 1) {
				firstWriteStarted();
				await writeGate;
			}
			return writeFile(...args);
		},
	);
	try {
		// Fix Date so the two different snapshots have the same timestamp.
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
		const older = warmRemoteJwks(url, { cachePath });
		await firstWrite;
		servedKeys = newKeys;
		const verifier = (await getRemoteJwks(url, { cachePath })) as Awaited<
			ReturnType<typeof getRemoteJwks>
		> & {
			reload: () => Promise<void>;
		};
		await verifier.reload();
		const newer = persistRemoteJwksIfPresent(url, cachePath);
		await Promise.resolve();
		assert.equal(
			mkdirSpy.mock.callCount(),
			1,
			"the second persistence request shares the active writer",
		);
		assert.equal(
			writes,
			1,
			"a newer snapshot cannot start an overlapping write",
		);
		releaseWrite();
		await Promise.all([older, newer]);
		assert.equal(writes, 2);
		assert.deepEqual((await loadPersistedJwksCache(cachePath)).jwks, newKeys);
		assert.deepEqual(await fs.readdir(directory), ["cache.json"]);
	} finally {
		releaseWrite();
		resetRemoteJwksForTests();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(directory, { recursive: true, force: true });
	}
});

void test("failed atomic replacement leaves no temporary snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lixray-jwks-failure-"));
	try {
		// Renaming a file onto a directory fails, after the temporary write.
		await assert.rejects(
			persistJwksCache(directory, { uat: Date.now(), jwks: { keys: [] } }),
		);
		const siblings = await fs.readdir(join(directory, ".."));
		assert.ok(
			!siblings.some((name) =>
				name.startsWith(`${directory.split("/").at(-1)}.`),
			),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
