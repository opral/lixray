import assert from "node:assert/strict";
import test from "node:test";
import { getCompatibility } from "../vendor/lix/scripts/compatibility.mjs";
import { checkProductionLix } from "./check-production-lix.mjs";

const compatibility = getCompatibility();
const repositoryId = "11111111-1111-4111-8111-111111111111";
const lixUrl = `https://lixray.example/lix/${repositoryId}`;
const principalId = "00000000-0000-7000-8000-000000000002";
const defaultBranchId = "00000000-0000-7000-8000-000000000003";
const globalBranchId = "ffffffff-ffff-7fff-bfff-ffffffffffff";
const identity = {
	repositoryId,
	principalId,
	protocolEpoch: compatibility.syncProtocolVersion,
	storageEpoch: compatibility.storageFormatVersion,
};
const handshake = {
	lixId: repositoryId,
	protocolVersion: compatibility.serverProtocolVersion,
	syncProtocolVersion: compatibility.syncProtocolVersion,
	activeAccountId: principalId,
	activeBranchId: defaultBranchId,
	sessionId: "session-1",
};
function success(url, init = {}) {
	const path = new URL(url).pathname;
	if (path.endsWith("/admission")) return Response.json(identity);
	if (
		path.endsWith("/execute") &&
		JSON.parse(init.body).sql.includes("lix_key_value")
	)
		return Response.json({
			columns: [{ name: "value", type: "jsonb" }],
			rows: [[{ kind: "jsonb", value: defaultBranchId }]],
		});
	if (path.endsWith("/execute"))
		return Response.json({ rows: [[{ kind: "int", value: 1 }]] });
	if (init.method === "DELETE") return new Response(null, { status: 204 });
	return Response.json(
		new URL(url).searchParams.get("activeBranchId") === globalBranchId
			? {
					...handshake,
					activeBranchId: globalBranchId,
					sessionId: "global-session",
				}
			: handshake,
	);
}

void test("checks browser admission before SQL using canonical SDK compatibility", async () => {
	const requests = [];
	const result = await checkProductionLix({
		lixUrl,
		fetchImpl: async (url, init) => {
			const path = new URL(url).pathname;
			const headers = new Headers(init.headers);
			assert.equal(init.cache, "no-store");
			assert.equal(init.redirect, "error");
			assert.equal(init.credentials, "omit");
			assert.equal(
				headers.get(
					path.endsWith("/admission")
						? "lix-sync-protocol-version"
						: "lix-server-protocol-version",
				),
				String(
					path.endsWith("/admission")
						? compatibility.syncProtocolVersion
						: compatibility.serverProtocolVersion,
				),
			);
			requests.push([
				init.method ?? "GET",
				path,
				headers.get("Lix-Session-Id"),
			]);
			return success(url, init);
		},
	});
	assert.deepEqual(result, {
		protocolVersion: compatibility.serverProtocolVersion,
		lix: `/lix/${repositoryId}`,
	});
	assert.deepEqual(requests, [
		["GET", `/lix/v1/${repositoryId}/admission`, null],
		["GET", `/lix/v1/${repositoryId}/`, null],
		["POST", `/lix/v1/${repositoryId}/execute`, "session-1"],
		["GET", `/lix/v1/${repositoryId}/`, null],
		["POST", `/lix/v1/${repositoryId}/execute`, "global-session"],
		["DELETE", `/lix/v1/${repositoryId}/session`, "global-session"],
		["DELETE", `/lix/v1/${repositoryId}/session`, "session-1"],
	]);
});

void test("rejects missing or mismatched canonical default settings and closes both sessions", async () => {
	for (const rows of [[], [[{ kind: "jsonb", value: principalId }]]]) {
		const closed = [];
		await assert.rejects(
			checkProductionLix({
				lixUrl,
				fetchImpl: async (url, init) => {
					if (init.method === "DELETE")
						closed.push(new Headers(init.headers).get("Lix-Session-Id"));
					if (
						new URL(url).pathname.endsWith("/execute") &&
						JSON.parse(init.body).sql.includes("lix_key_value")
					)
						return Response.json({
							columns: [{ name: "value", type: "jsonb" }],
							rows,
						});
					return success(url, init);
				},
			}),
			/canonical default branch is missing or disagrees/,
		);
		assert.deepEqual(closed, ["global-session", "session-1"]);
	}
});

void test("awaits only typed migration progress before opening a SQL session", async () => {
	let admissions = 0;
	const delays = [];
	await checkProductionLix({
		lixUrl,
		sleepImpl: async (delay) => {
			delays.push(delay);
		},
		fetchImpl: async (url, init) => {
			if (new URL(url).pathname.endsWith("/admission") && ++admissions <= 2) {
				return Response.json(
					{ error: { code: "LIX_REPOSITORY_MIGRATING" } },
					{ status: 503 },
				);
			}
			assert.equal(admissions, 3, "SQL starts only after successful admission");
			return success(url, init);
		},
	});
	assert.deepEqual(delays, [1_000, 1_000]);
});

void test("migration polling has a finite deployment budget", async () => {
	let calls = 0;
	await assert.rejects(
		checkProductionLix({
			lixUrl,
			sleepImpl: async () => {},
			fetchImpl: async () => {
				calls += 1;
				return Response.json(
					{ error: { code: "LIX_REPOSITORY_MIGRATING" } },
					{ status: 503 },
				);
			},
		}),
		/timed out.*LIX_REPOSITORY_MIGRATING/,
	);
	assert.equal(calls, 120);
	await assert.rejects(
		checkProductionLix({
			lixUrl,
			admissionTimeoutMs: 0,
			fetchImpl: async () => {
				assert.fail("expired admission budget must not issue a request");
			},
		}),
		/timed out/,
	);
});

void test("authentication, compatibility and untyped failures stop admission immediately", async () => {
	for (const [status, code] of [
		[401, "UNAUTHORIZED"],
		[403, "FORBIDDEN"],
		[409, "LIX_MIGRATION_REQUIRED"],
		[426, "LIX_PROTOCOL_MISMATCH"],
		[503, "LIX_MIGRATION_REQUIRED"],
		[503, "LIX_ERROR_RECOVERING"],
		[500, "LIX_REPOSITORY_MIGRATING"],
	]) {
		let calls = 0;
		await assert.rejects(
			checkProductionLix({
				lixUrl,
				fetchImpl: async () => {
					calls += 1;
					return Response.json({ error: { code } }, { status });
				},
			}),
			new RegExp(`admission failed with HTTP ${status} ${code}`),
		);
		assert.equal(calls, 1);
	}
});

void test("rejects invalid repository, principal and epochs before SQL", async () => {
	for (const patch of [
		{ repositoryId: "another-repository" },
		{ principalId: "" },
		{ principalId: "line\nbreak" },
		{ protocolEpoch: identity.protocolEpoch - 1 },
		{ storageEpoch: identity.storageEpoch - 1 },
	]) {
		let calls = 0;
		await assert.rejects(
			checkProductionLix({
				lixUrl,
				fetchImpl: async () => {
					calls += 1;
					return Response.json({ ...identity, ...patch });
				},
			}),
			/admission returned an invalid identity or compatibility epoch/,
		);
		assert.equal(calls, 1);
	}
});

void test("a changed session principal prevents SQL and still closes the session", async () => {
	const methods = [];
	await assert.rejects(
		checkProductionLix({
			lixUrl,
			fetchImpl: async (url, init) => {
				methods.push(init.method ?? "GET");
				if (new URL(url).pathname.endsWith(`/${repositoryId}/`))
					return Response.json({
						...handshake,
						activeAccountId: "someone-else",
					});
				return success(url, init);
			},
		}),
		/handshake returned an invalid response/,
	);
	assert.deepEqual(methods, ["GET", "GET", "DELETE"]);
});

void test("fails when the canary session cannot close", async () => {
	await assert.rejects(
		checkProductionLix({
			lixUrl,
			fetchImpl: async (url, init) => {
				if (init.method === "DELETE")
					return Response.json(
						{ error: { code: "LIX_ERROR_INTERNAL" } },
						{ status: 500 },
					);
				return success(url, init);
			},
		}),
		/close failed with HTTP 500 LIX_ERROR_INTERNAL/,
	);
});

void test("closes sessions allocated in unsuccessful handshake responses", async () => {
	for (const globalFailure of [false, true]) {
		const closed = [];
		await assert.rejects(
			checkProductionLix({
				lixUrl,
				fetchImpl: async (url, init) => {
					const parsed = new URL(url);
					const isHandshake = parsed.pathname.endsWith(`/${repositoryId}/`);
					const isGlobal =
						parsed.searchParams.get("activeBranchId") === globalBranchId;
					if (init.method === "DELETE")
						closed.push(new Headers(init.headers).get("Lix-Session-Id"));
					if (isHandshake && isGlobal === globalFailure)
						return Response.json(
							{
								sessionId: isGlobal ? "global-session" : "session-1",
								error: { code: "HANDSHAKE_FAILED" },
							},
							{ status: 500 },
						);
					return success(url, init);
				},
			}),
			/handshake failed with HTTP 500 HANDSHAKE_FAILED/,
		);
		assert.deepEqual(
			closed,
			globalFailure ? ["global-session", "session-1"] : ["session-1"],
		);
	}
});

void test("preserves the read failure if session cleanup fails too", async () => {
	await assert.rejects(
		checkProductionLix({
			lixUrl,
			fetchImpl: async (url, init) => {
				if (init.method === "DELETE") throw new Error("cleanup failed");
				if (new URL(url).pathname.endsWith("/execute"))
					return Response.json(
						{ error: { code: "READ_FAILED" } },
						{ status: 500 },
					);
				return success(url, init);
			},
		}),
		/read failed with HTTP 500 READ_FAILED/,
	);
});

void test("rejects non-root and plaintext production connection URLs", async () => {
	for (const url of [
		`https://lixray.example/prefix/lix/${repositoryId}`,
		`http://lixray.example/lix/${repositoryId}`,
		`${lixUrl}/`,
	]) {
		await assert.rejects(
			checkProductionLix({
				lixUrl: url,
				fetchImpl: async () => new Response(),
			}),
		);
	}
});

void test("awaits typed handshake migration after catalog admission without replaying SQL", async () => {
	let handshakes = 0;
	let executes = 0;
	const delays = [];
	await checkProductionLix({
		lixUrl,
		sleepImpl: async (delay) => {
			delays.push(delay);
		},
		fetchImpl: async (url, init) => {
			const path = new URL(url).pathname;
			if (path.endsWith(`/${repositoryId}/`) && ++handshakes <= 2)
				return Response.json(
					{ error: { code: "LIX_ERROR_MIGRATING" } },
					{ status: 503 },
				);
			if (path.endsWith("/execute")) {
				executes += 1;
				assert.equal(
					handshakes,
					JSON.parse(init.body).sql.includes("lix_key_value") ? 4 : 3,
				);
			}
			return success(url, init);
		},
	});
	assert.deepEqual(delays, [1000, 1000]);
	assert.equal(executes, 2);
});

void test("handshake migration is bounded and other failures are terminal", async () => {
	for (const code of ["LIX_ERROR_MIGRATING", "LIX_ERROR_RECOVERING"]) {
		let handshakes = 0;
		await assert.rejects(
			checkProductionLix({
				lixUrl,
				sleepImpl: async () => {},
				fetchImpl: async (url, init) => {
					if (new URL(url).pathname.endsWith("/admission"))
						return success(url, init);
					handshakes += 1;
					return Response.json({ error: { code } }, { status: 503 });
				},
			}),
			code === "LIX_ERROR_MIGRATING"
				? /handshake timed out/
				: /handshake failed.*LIX_ERROR_RECOVERING/,
		);
		assert.equal(handshakes, code === "LIX_ERROR_MIGRATING" ? 120 : 1);
	}
});

void test("hosted admission can route to a different embedded repository identity", async () => {
	let reads = 0;
	await checkProductionLix({
		lixUrl,
		fetchImpl: async (url, init) => {
			if (new URL(url).pathname.endsWith(`/${repositoryId}/`)) {
				const isGlobal =
					new URL(url).searchParams.get("activeBranchId") === globalBranchId;
				return Response.json({
					...handshake,
					activeBranchId: isGlobal ? globalBranchId : defaultBranchId,
					sessionId: isGlobal ? "global-session" : "session-1",
					lixId: "22222222-2222-4222-8222-222222222222",
				});
			}
			if (init.method === "POST") reads++;
			return success(url, init);
		},
	});
	assert.equal(reads, 2);
});

void test("invalid embedded identity closes the allocated session before SQL", async () => {
	for (const lixId of [undefined, "", "not-a-repository-id"]) {
		const methods = [];
		await assert.rejects(
			checkProductionLix({
				lixUrl,
				fetchImpl: async (url, init) => {
					methods.push(init.method ?? "GET");
					if (new URL(url).pathname.endsWith(`/${repositoryId}/`))
						return Response.json({ ...handshake, lixId });
					return success(url, init);
				},
			}),
			/handshake returned an invalid response/,
		);
		assert.deepEqual(methods, ["GET", "GET", "DELETE"]);
	}
});

function openingStage(url) {
	const parsed = new URL(url);
	if (parsed.pathname.endsWith("/admission")) return "admission";
	if (parsed.pathname.endsWith(`/${repositoryId}/`))
		return parsed.searchParams.get("activeBranchId") === globalBranchId
			? "global handshake"
			: "handshake";
	return undefined;
}

void test("awaits explicitly retryable current opening at admission and both handshakes", async () => {
	for (const code of ["LIX_REPOSITORY_OPENING", "LIX_OPEN_DEADLINE_EXCEEDED"]) {
		for (const stage of ["admission", "handshake", "global handshake"]) {
			let attempts = 0;
			let reads = 0;
			const delays = [];
			const closed = [];
			await checkProductionLix({
				lixUrl,
				sleepImpl: async (delay) => delays.push(delay),
				fetchImpl: async (url, init) => {
					if (openingStage(url) === stage && ++attempts <= 2)
						return Response.json(
							{
								error: {
									code,
									details: {
										retryable: true,
										stalled: false,
										openPhase: "storage_migrating",
									},
								},
							},
							{ status: 503 },
						);
					if (init.method === "POST") {
						reads += 1;
						if (stage !== "global handshake" || reads === 2)
							assert.equal(
								attempts,
								3,
								"SQL waits for the required admission and session",
							);
					}
					if (init.method === "DELETE")
						closed.push(new Headers(init.headers).get("Lix-Session-Id"));
					return success(url, init);
				},
			});
			assert.equal(attempts, 3);
			assert.equal(reads, 2, "opening retries never replay SQL");
			assert.deepEqual(delays, [1_000, 1_000]);
			assert.deepEqual(closed, ["global-session", "session-1"]);
		}
	}
});

void test("current opening retries stop immediately for missing authorization, terminal progress and wrong status", async () => {
	const failures = [];
	for (const code of ["LIX_REPOSITORY_OPENING", "LIX_OPEN_DEADLINE_EXCEEDED"]) {
		for (const details of [
			undefined,
			{},
			{ retryable: false },
			{ retryable: "true" },
			{ retryable: true, stalled: true },
			{ retryable: true, openPhase: "failed" },
		])
			failures.push({ status: 503, code, details });
		for (const status of [500, 404])
			failures.push({ status, code, details: { retryable: true } });
	}
	for (const code of [
		"LIX_OPEN_STALLED",
		"LIX_OPEN_FAILED",
		"LIX_ERROR_MIGRATION_FAILED",
		"LIX_ERROR_RECOVERING",
	])
		failures.push({ status: 503, code, details: { retryable: true } });
	for (const stage of ["admission", "handshake", "global handshake"]) {
		for (const { status, code, details } of failures) {
			let attempts = 0;
			const closed = [];
			await assert.rejects(
				checkProductionLix({
					lixUrl,
					sleepImpl: async () =>
						assert.fail("terminal opening responses must not be polled"),
					fetchImpl: async (url, init) => {
						if (openingStage(url) === stage) {
							attempts += 1;
							return Response.json({ error: { code, details } }, { status });
						}
						if (init.method === "DELETE")
							closed.push(new Headers(init.headers).get("Lix-Session-Id"));
						return success(url, init);
					},
				}),
				new RegExp(`${stage} failed with HTTP ${status} ${code}`),
			);
			assert.equal(attempts, 1);
			assert.deepEqual(
				closed,
				stage === "global handshake" ? ["session-1"] : [],
			);
		}
	}
});

void test("current opening polling retains the 120 attempt deployment bound at every stage", async () => {
	for (const stage of ["admission", "handshake", "global handshake"]) {
		for (const code of [
			"LIX_REPOSITORY_OPENING",
			"LIX_OPEN_DEADLINE_EXCEEDED",
		]) {
			let attempts = 0;
			let sleeps = 0;
			await assert.rejects(
				checkProductionLix({
					lixUrl,
					sleepImpl: async () => {
						sleeps += 1;
					},
					fetchImpl: async (url, init) => {
						if (openingStage(url) === stage) {
							attempts += 1;
							return Response.json(
								{ error: { code, details: { retryable: true } } },
								{ status: 503 },
							);
						}
						return success(url, init);
					},
				}),
				new RegExp(`(?:admission|handshake) timed out waiting for ${code}`),
			);
			assert.equal(attempts, 120);
			assert.equal(sleeps, 119);
		}
	}
});

void test("explicit terminal metadata also stops legacy migration polling", async () => {
	for (const [stage, code] of [
		["admission", "LIX_REPOSITORY_MIGRATING"],
		["handshake", "LIX_ERROR_MIGRATING"],
		["global handshake", "LIX_ERROR_MIGRATING"],
	]) {
		for (const details of [
			{ retryable: false },
			{ stalled: true },
			{ openPhase: "failed" },
		]) {
			let attempts = 0;
			await assert.rejects(
				checkProductionLix({
					lixUrl,
					sleepImpl: async () =>
						assert.fail("explicit terminal metadata must not be retried"),
					fetchImpl: async (url, init) => {
						if (openingStage(url) === stage) {
							attempts += 1;
							return Response.json(
								{ error: { code, details } },
								{ status: 503 },
							);
						}
						return success(url, init);
					},
				}),
				new RegExp(`${stage} failed with HTTP 503 ${code}`),
			);
			assert.equal(attempts, 1);
		}
	}
});
