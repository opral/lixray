import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { errors } from "jose";
import {
	classifyJwtVerifyError,
	loadPersistedJwksCache,
	persistJwksCache,
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
