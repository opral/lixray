import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalAccountIdFromAccessToken,
	shouldRefreshCanonicalAccountClaim,
} from "./canonical-account.ts";

const ACCOUNT_ID = "20000000-0000-4000-8000-000000000001";

void test("reads the canonical account id independently of the auth subject", () => {
	assert.equal(
		canonicalAccountIdFromAccessToken(
			unsignedJwt({
				sub: "10000000-0000-4000-8000-000000000001",
				account_id: ACCOUNT_ID,
			}),
		),
		ACCOUNT_ID,
	);
	assert.equal(
		canonicalAccountIdFromAccessToken(
			unsignedJwt({
				sub: "10000000-0000-4000-8000-000000000002",
				account_id: ACCOUNT_ID,
			}),
		),
		ACCOUNT_ID,
	);
});

void test("fails closed when the canonical account claim is absent or malformed", () => {
	assert.equal(canonicalAccountIdFromAccessToken(undefined), null);
	assert.equal(canonicalAccountIdFromAccessToken("not-a-jwt"), null);
	assert.equal(
		canonicalAccountIdFromAccessToken(unsignedJwt({ sub: "auth" })),
		null,
	);
	assert.equal(
		canonicalAccountIdFromAccessToken(
			unsignedJwt({ account_id: "not-an-account-id" }),
		),
		null,
	);
});

void test("refreshes a pre-cutover session once and then fails closed", () => {
	assert.equal(
		shouldRefreshCanonicalAccountClaim({
			accountId: null,
			authUserId: "auth-user",
			attemptedAuthUserId: null,
		}),
		true,
	);
	assert.equal(
		shouldRefreshCanonicalAccountClaim({
			accountId: null,
			authUserId: "auth-user",
			attemptedAuthUserId: "auth-user",
		}),
		false,
	);
	assert.equal(
		shouldRefreshCanonicalAccountClaim({
			accountId: ACCOUNT_ID,
			authUserId: "auth-user",
			attemptedAuthUserId: null,
		}),
		false,
	);
});

function unsignedJwt(payload: Record<string, unknown>): string {
	return [
		base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
		base64Url(JSON.stringify(payload)),
		"signature",
	].join(".");
}

function base64Url(value: string): string {
	return Buffer.from(value).toString("base64url");
}
