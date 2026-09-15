import { compatibility } from "@lix-js/sdk/compatibility";
import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { provisionAccountAfterHandshake } from "../../src/mcp/lix-account-provisioning.ts";
import { lixServiceRequestHeaders } from "../../src/lib/lix-service-proxy.ts";

const serviceUrl =
	process.env.LIXRAY_ACCOUNT_TEST_SERVICE_URL ?? "http://127.0.0.1:18080";
const internalToken =
	process.env.LIXRAY_ACCOUNT_TEST_INTERNAL_TOKEN ??
	"lixray-local-internal-token";

test("real Lix server enriches null and changed profiles and leaves unchanged history intact", async () => {
	assert.ok(serviceUrl);
	assert.ok(internalToken, "LIXRAY_ACCOUNT_TEST_INTERNAL_TOKEN is required");
	const account = {
		id: crypto.randomUUID(),
		name: "Profile regression account",
		kind: "human",
		profileUri: "https://lixray.example/profile/regression",
	};
	const lixFetch = (request: Request) =>
		fetch(
			new Request(new URL(new URL(request.url).pathname, serviceUrl), request),
			{
				headers: lixServiceRequestHeaders(request.headers, internalToken),
			},
		);
	const created = await lixFetch(
		new Request(new URL("/lix/v1", serviceUrl), {
			method: "POST",
			headers: {
				"x-lixray-idempotency-principal": account.id,
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
				"Idempotency-Key": crypto.randomUUID(),
			},
		}),
	);
	assert.equal(created.status, 201, await created.clone().text());
	const { id: lixId } = (await created.json()) as { id: string };
	const protocolPath = `/lix/v1/${lixId}/`;
	const handshake = await lixFetch(
		new Request(new URL(protocolPath, serviceUrl), {
			headers: {
				"x-lixray-idempotency-principal": account.id,
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
			},
		}),
	);
	assert.equal(handshake.status, 200, await handshake.clone().text());
	const { sessionId, activeAccountId } = (await handshake.clone().json()) as {
		sessionId: string;
		activeAccountId: string;
	};
	assert.equal(activeAccountId, account.id);
	const sessionHeaders = {
		"Content-Type": "application/json",
		"Lix-Server-Protocol-Version": String(compatibility.serverProtocolVersion),
		"Lix-Session-Id": sessionId,
		"x-lixray-idempotency-principal": account.id,
	};
	const execute = async (sql: string, params: string[] = []) => {
		const response = await lixFetch(
			new Request(new URL(`${protocolPath}execute`, serviceUrl), {
				method: "POST",
				headers: { ...sessionHeaders, "Idempotency-Key": crypto.randomUUID() },
				body: JSON.stringify({
					sql,
					params: params.map((value) => ({ kind: "text", value })),
				}),
			}),
		);
		assert.equal(response.status, 200, await response.clone().text());
		return (await response.json()) as {
			rows: Array<Array<{ kind: string; value: unknown }>>;
		};
	};
	const profile = async () =>
		(
			await execute(
				"SELECT name, kind, profile_uri FROM lix_account WHERE id = $1",
				[account.id],
			)
		).rows[0].map((cell) => cell.value);
	const changeCount = async () =>
		(
			await execute(
				"SELECT count(*) FROM lix_change WHERE schema_key = 'lix_account'",
			)
		).rows[0][0].value;
	const provision = async () => {
		const response = await provisionAccountAfterHandshake({
			lixId,
			protocolPath,
			response: handshake,
			account,
			lixFetch,
		});
		assert.equal(response.status, 200, await response.clone().text());
	};
	try {
		assert.deepEqual(await profile(), [account.id, "human", null]);
		await provision();
		assert.deepEqual(await profile(), [
			account.name,
			account.kind,
			account.profileUri,
		]);
		const countAfterProvision = await changeCount();
		await provision();
		assert.equal(
			await changeCount(),
			countAfterProvision,
			"unchanged profile must not append account history",
		);
		account.name = "Updated regression account";
		account.profileUri = "https://lixray.example/profile/updated";
		await provision();
		assert.deepEqual(await profile(), [
			account.name,
			account.kind,
			account.profileUri,
		]);
		assert.deepEqual(
			(
				await execute(
					"SELECT name, profile_uri FROM lix_account WHERE id = $1",
					["00000000-0000-7000-8000-000000000002"],
				)
			).rows[0].map((cell) => cell.value),
			["Anonymous", null],
			"other accounts must not be updated",
		);
	} finally {
		const close = await lixFetch(
			new Request(new URL(`${protocolPath}session`, serviceUrl), {
				method: "DELETE",
				headers: sessionHeaders,
			}),
		);
		assert.equal(close.status, 204, await close.text());
	}
});
