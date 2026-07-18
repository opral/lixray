import assert from "node:assert/strict";
import test from "node:test";
import {
	authenticatePreviewDemoBrowser,
	authenticatePreviewDemoMcp,
	authorizePreviewDemoWorkspace,
	createPreviewShareService,
	handlePreviewShareRequest,
	previewAllowedWorkspaceIds,
	previewShareTokenKey,
	type PreviewShareService,
} from "./preview-share-service.ts";
import { handleRequest } from "./handler.ts";

const HOST_A = "pr-53-lixray-preview.example.workers.dev";
const HOST_B = "version-53-lixray-preview.example.workers.dev";
const WORKSPACE_A = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_B = "00000000-0000-4000-8000-000000000003";
const DISALLOWED_WORKSPACE = "00000000-0000-4000-8000-000000000004";

void test("preview share service mints an opaque R2-backed capability", async () => {
	const storage = new FakeR2Bucket();
	const service = previewService(storage, HOST_A);

	const minted = await service.mint({
		workspaceId: WORKSPACE_A,
		sharedByName: "Mara",
	});

	assert.match(minted.token, /^[A-Za-z0-9_-]{43}$/);
	assert.deepEqual(minted, {
		token: minted.token,
		workspaceId: WORKSPACE_A,
		sharedByName: "Mara",
		grantsEdit: true,
	});
	assert.deepEqual(
		JSON.parse(
			storage.text(previewShareTokenKey(HOST_A, minted.token)) ?? "{}",
		),
		{
			version: 1,
			workspaceId: WORKSPACE_A,
			sharedByName: "Mara",
			grantsEdit: true,
		},
	);

	assert.deepEqual(await service.resolve(minted.token), minted);
	assert.deepEqual(await service.accept(minted.token), minted);
});

void test("preview shares are isolated by preview hostname", async () => {
	const storage = new FakeR2Bucket();
	const sender = previewService(storage, HOST_A);
	const recipientOnSamePreview = previewService(storage, HOST_A);
	const recipientOnAnotherPreview = previewService(storage, HOST_B);
	const minted = await sender.mint({
		workspaceId: WORKSPACE_A,
		sharedByName: "Mara",
	});

	assert.deepEqual(await recipientOnSamePreview.resolve(minted.token), minted);
	assert.equal(await recipientOnAnotherPreview.resolve(minted.token), null);
});

void test("minting rejects workspaces that are not enabled for this demo preview", async () => {
	const storage = new FakeR2Bucket();
	const service = previewService(storage, HOST_A);

	await assert.rejects(
		service.mint({
			workspaceId: DISALLOWED_WORKSPACE,
			sharedByName: "Mara",
		}),
		(error: unknown) =>
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "PREVIEW_SHARE_WORKSPACE_NOT_ALLOWED",
	);
	assert.equal(storage.keys().length, 0);
});

void test("resolve and accept fail closed for malformed, corrupted, and no-longer-allowed records", async () => {
	const storage = new FakeR2Bucket();
	const service = previewService(storage, HOST_A);
	const token = "A".repeat(43);

	assert.equal(await service.resolve("not-a-capability"), null);
	await storage.putRaw(previewShareTokenKey(HOST_A, token), "{not-json");
	assert.equal(await service.resolve(token), null);

	await storage.putRaw(
		previewShareTokenKey(HOST_A, token),
		JSON.stringify({
			version: 1,
			workspaceId: DISALLOWED_WORKSPACE,
			sharedByName: "Mara",
			grantsEdit: true,
		}),
	);
	assert.equal(await service.accept(token), null);
});

void test("token collision retries with a new opaque token without replacing the original", async () => {
	const storage = new FakeR2Bucket();
	const collidingToken = "B".repeat(43);
	const nextToken = "C".repeat(43);
	await storage.putRaw(
		previewShareTokenKey(HOST_A, collidingToken),
		JSON.stringify({
			version: 1,
			workspaceId: WORKSPACE_B,
			sharedByName: "Existing sender",
			grantsEdit: true,
		}),
	);
	let calls = 0;
	const service = previewService(storage, HOST_A, () => {
		calls += 1;
		return calls === 1 ? collidingToken : nextToken;
	});

	const minted = await service.mint({
		workspaceId: WORKSPACE_A,
		sharedByName: "Mara",
	});

	assert.equal(minted.token, nextToken);
	assert.equal(calls, 2);
	assert.deepEqual(await service.resolve(collidingToken), {
		token: collidingToken,
		workspaceId: WORKSPACE_B,
		sharedByName: "Existing sender",
		grantsEdit: true,
	});
});

void test("preview allowed-workspace parsing trims empty entries", () => {
	assert.deepEqual(
		previewAllowedWorkspaceIds(` ${WORKSPACE_A},, ${WORKSPACE_B} , `),
		new Set([WORKSPACE_A, WORKSPACE_B]),
	);
});

void test("the preview HTTP adapter requires a test session for minting and accepting", async () => {
	const storage = new FakeR2Bucket();
	const env = {
		LIXRAY_DEMO: "1",
		LIXRAY_DEMO_WORKSPACE_IDS: `${WORKSPACE_A},${WORKSPACE_B}`,
		PREVIEW_STATE: storage.bucket,
	};
	const baseUrl = `https://${HOST_A}/_preview/workspace-share-capabilities`;
	const sessionUrl = `https://${HOST_A}/_preview/demo-session`;

	const unauthenticatedMint = await handlePreviewShareRequest(
		new Request(baseUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceId: WORKSPACE_A }),
		}),
		env,
	);
	assert.ok(unauthenticatedMint);
	assert.equal(unauthenticatedMint.status, 401);

	const ownerSessionResponse = await handlePreviewShareRequest(
		new Request(sessionUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "owner" }),
		}),
		env,
	);
	assert.ok(ownerSessionResponse);
	assert.deepEqual(await ownerSessionResponse.json(), {
		signedIn: true,
		workspaceIds: [WORKSPACE_A, WORKSPACE_B],
	});
	const ownerCookie = sessionCookie(ownerSessionResponse);
	assert.match(ownerCookie, /^lixray_preview_session=[A-Za-z0-9_-]{43}$/);
	const ownerSetCookie = ownerSessionResponse.headers.get("Set-Cookie") ?? "";
	assert.match(ownerSetCookie, /HttpOnly/);
	assert.match(ownerSetCookie, /SameSite=Lax/);
	assert.match(ownerSetCookie, /Max-Age=43200/);
	assert.match(ownerSetCookie, /Secure/);

	const mintedResponse = await handlePreviewShareRequest(
		new Request(baseUrl, {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ workspaceId: WORKSPACE_A }),
		}),
		env,
	);
	assert.ok(mintedResponse);
	assert.equal(mintedResponse.status, 200);
	assert.equal(mintedResponse.headers.get("Cache-Control"), "no-store");
	const minted: unknown = await mintedResponse.json();
	assert.ok(minted && typeof minted === "object" && "token" in minted);
	const token = minted.token;
	if (typeof token !== "string") throw new Error("Expected a preview token");

	const resolvedResponse = await handlePreviewShareRequest(
		new Request(`${baseUrl}/${token}`),
		env,
	);
	assert.ok(resolvedResponse);
	assert.deepEqual(await resolvedResponse.json(), {
		workspaceId: WORKSPACE_A,
		sharedByName: "Preview test account",
		grantsEdit: true,
	});

	const recipientSessionResponse = await handlePreviewShareRequest(
		new Request(sessionUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "recipient" }),
		}),
		env,
	);
	assert.ok(recipientSessionResponse);
	assert.deepEqual(await recipientSessionResponse.json(), {
		signedIn: true,
		workspaceIds: [],
	});
	const recipientCookie = sessionCookie(recipientSessionResponse);

	const unauthenticatedAccept = await handlePreviewShareRequest(
		new Request(`${baseUrl}/${token}/accept`, { method: "POST" }),
		env,
	);
	assert.ok(unauthenticatedAccept);
	assert.equal(unauthenticatedAccept.status, 401);

	const acceptedResponse = await handlePreviewShareRequest(
		new Request(`${baseUrl}/${token}/accept`, {
			method: "POST",
			headers: { Cookie: recipientCookie },
		}),
		env,
	);
	assert.ok(acceptedResponse);
	assert.deepEqual(await acceptedResponse.json(), {
		workspaceId: WORKSPACE_A,
		sharedByName: "Preview test account",
		grantsEdit: true,
	});
	const recipientSession = await handlePreviewShareRequest(
		new Request(sessionUrl, { headers: { Cookie: recipientCookie } }),
		env,
	);
	assert.ok(recipientSession);
	assert.deepEqual(await recipientSession.json(), {
		signedIn: true,
		workspaceIds: [WORKSPACE_A],
	});

	const signedOutResponse = await handlePreviewShareRequest(
		new Request(sessionUrl, {
			method: "DELETE",
			headers: { Cookie: recipientCookie },
		}),
		env,
	);
	assert.ok(signedOutResponse);
	assert.equal(signedOutResponse.status, 204);
	assert.match(signedOutResponse.headers.get("Set-Cookie") ?? "", /Max-Age=0/);

	assert.equal(
		await handlePreviewShareRequest(new Request(baseUrl), {
			...env,
			LIXRAY_DEMO: "",
		}),
		null,
	);
});

void test("preview workspace writes require both the demo bearer and a server session", async () => {
	const storage = new FakeR2Bucket();
	const env = {
		LIXRAY_DEMO: "1",
		LIXRAY_DEMO_WORKSPACE_IDS: `${WORKSPACE_A},${WORKSPACE_B}`,
		PREVIEW_STATE: storage.bucket,
	};
	const sessionUrl = `https://${HOST_A}/_preview/demo-session`;
	const sessionResponse = await handlePreviewShareRequest(
		new Request(sessionUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "recipient" }),
		}),
		env,
	);
	assert.ok(sessionResponse);
	const cookie = sessionCookie(sessionResponse);

	const bearerOnly = await authenticatePreviewDemoBrowser(
		new Request(`https://${HOST_A}/v1/workspaces/${WORKSPACE_A}/execute`, {
			headers: { Authorization: "Bearer lixray-demo" },
		}),
		env,
	);
	assert.equal(bearerOnly.ok, false);
	if (!bearerOnly.ok) assert.equal(bearerOnly.response.status, 401);

	const sessionOnly = await authenticatePreviewDemoBrowser(
		new Request(`https://${HOST_A}/v1/workspaces/${WORKSPACE_A}/execute`, {
			headers: { Cookie: cookie },
		}),
		env,
	);
	assert.equal(sessionOnly.ok, false);
	if (!sessionOnly.ok) assert.equal(sessionOnly.response.status, 401);

	const authenticated = await authenticatePreviewDemoBrowser(
		new Request(`https://${HOST_A}/v1/workspaces/${WORKSPACE_A}/execute`, {
			headers: {
				Authorization: "Bearer lixray-demo",
				Cookie: cookie,
			},
		}),
		env,
	);
	assert.equal(authenticated.ok, true);
	if (authenticated.ok) {
		assert.equal(
			(
				await authorizePreviewDemoWorkspace(
					WORKSPACE_A,
					authenticated.auth,
					env,
				)
			)?.status,
			403,
		);
	}

	const mcpWithoutSession = await authenticatePreviewDemoMcp(
		new Request(`https://${HOST_A}/mcp`),
		env,
	);
	assert.equal(mcpWithoutSession.ok, false);
	const mcpWithSession = await authenticatePreviewDemoMcp(
		new Request(`https://${HOST_A}/mcp`, { headers: { Cookie: cookie } }),
		env,
	);
	assert.equal(mcpWithSession.ok, true);
});

void test("anonymous preview requests are forwarded only through the read-only transport", async () => {
	const storage = new FakeR2Bucket();
	const env = {
		LIXRAY_DEMO: "1",
		LIXRAY_DEMO_WORKSPACE_IDS: WORKSPACE_A,
		PREVIEW_STATE: storage.bucket,
	};
	const forwarded: Array<{ method: string; readOnly: string | null }> = [];
	const options = {
		authenticate: (request: Request) =>
			authenticatePreviewDemoBrowser(request, env),
		authorizeWorkspace: (
			workspaceId: string,
			auth: Parameters<typeof authorizePreviewDemoWorkspace>[1],
		) => authorizePreviewDemoWorkspace(workspaceId, auth, env),
		workspaceFetch: async (_workspaceId: string, request: Request) => {
			forwarded.push({
				method: request.method,
				readOnly: request.headers.get("X-Lixray-Read-Only"),
			});
			return request.method === "POST" &&
				request.headers.get("X-Lixray-Read-Only") === "1"
				? Response.json({ error: "Read-only" }, { status: 403 })
				: Response.json({ ok: true });
		},
	};

	const blockedWrite = await handleRequest(
		new Request(`https://${HOST_A}/v1/workspaces/${WORKSPACE_A}/execute`, {
			method: "POST",
			headers: { Authorization: "Bearer lixray-demo" },
			body: JSON.stringify({
				branchId: "main",
				sql: "INSERT INTO lix_file VALUES (1)",
			}),
		}),
		env,
		options,
	);
	assert.equal(blockedWrite.status, 403);
	assert.deepEqual(forwarded, [{ method: "POST", readOnly: "1" }]);

	const publicRead = await handleRequest(
		new Request(`https://${HOST_A}/v1/workspaces/${WORKSPACE_A}/branches`, {
			headers: { Authorization: "Bearer lixray-demo" },
		}),
		env,
		options,
	);
	assert.equal(publicRead.status, 200);
	assert.deepEqual(forwarded, [
		{ method: "POST", readOnly: "1" },
		{ method: "GET", readOnly: "1" },
	]);
});

function previewService(
	storage: FakeR2Bucket,
	hostname: string,
	tokenGenerator?: () => string,
): PreviewShareService {
	return createPreviewShareService({
		previewState: storage.bucket,
		hostname,
		allowedWorkspaceIds: [WORKSPACE_A, WORKSPACE_B],
		tokenGenerator,
	});
}

class FakeR2Bucket {
	readonly bucket = this as unknown as R2Bucket;
	#revision = 0;
	#objects = new Map<string, { bytes: Uint8Array; etag: string }>();

	keys() {
		return [...this.#objects.keys()];
	}

	text(key: string) {
		const bytes = this.#objects.get(key)?.bytes;
		return bytes ? new TextDecoder().decode(bytes) : undefined;
	}

	async putRaw(key: string, value: string) {
		await this.put(key, value);
	}

	async get(key: string) {
		const stored = this.#objects.get(key);
		if (!stored) return null;
		return {
			key,
			etag: stored.etag,
			size: stored.bytes.byteLength,
			arrayBuffer: async () =>
				stored.bytes.buffer.slice(
					stored.bytes.byteOffset,
					stored.bytes.byteOffset + stored.bytes.byteLength,
				),
		} as unknown as R2ObjectBody;
	}

	async put(key: string, value: string, options?: R2PutOptions) {
		const conditional = options?.onlyIf as R2Conditional | undefined;
		if (conditional?.etagDoesNotMatch === "*" && this.#objects.has(key)) {
			return null;
		}
		if (
			conditional?.etagMatches !== undefined &&
			conditional.etagMatches !== this.#objects.get(key)?.etag
		) {
			return null;
		}
		const bytes = new TextEncoder().encode(value);
		const stored = { bytes, etag: `etag-${++this.#revision}` };
		this.#objects.set(key, stored);
		return {
			key,
			etag: stored.etag,
			size: stored.bytes.byteLength,
		} as unknown as R2Object;
	}

	async delete(key: string) {
		this.#objects.delete(key);
	}
}

function sessionCookie(response: Response): string {
	const setCookie = response.headers.get("Set-Cookie");
	assert.ok(setCookie, "Expected preview session response to set a cookie");
	return setCookie.split(";", 1)[0];
}
