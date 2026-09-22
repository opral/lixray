import assert from "node:assert/strict";
import test from "node:test";
import {
	parseRepositoryOpenReport,
	captureRepositoryOpenReport,
} from "./repository-open-telemetry.ts";

const id = "11111111-1111-4111-8111-111111111111";
void test("server independently sanitizes browser diagnostics", () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		release: "a".repeat(40),
		diagnostic: {
			lix_error_code: "LIX_ADMISSION_EPOCH",
			httpStatus: 426,
			token: "secret",
			message: "secret",
		},
	});
	assert.deepEqual(report, {
		repositoryId: id,
		release: "a".repeat(40),
		fields: { lix_error_code: "LIX_ADMISSION_EPOCH", httpStatus: 426 },
	});
	assert.equal(parseRepositoryOpenReport({ repositoryId: "invalid" }), null);
});

void test("server delivers exceptions independently of browser PostHog", async () => {
	const report = parseRepositoryOpenReport({
		repositoryId: id,
		diagnostic: {},
	})!;
	let payload: Record<string, unknown> = {};
	assert.equal(
		await captureRepositoryOpenReport(
			report,
			"actor",
			{
				POSTHOG_PROJECT_TOKEN: "project-token",
				POSTHOG_ENVIRONMENT: "production",
			},
			async (_url, init) => {
				payload = JSON.parse(init?.body as string) as Record<string, unknown>;
				return new Response("{}", { status: 200 });
			},
		),
		true,
	);
	assert.equal(payload.event, "$exception");
	const properties = payload.properties as Record<string, unknown>;
	assert.equal(properties.operation, "repository_open");
	assert.equal(properties.delivery, "first_party");
});

void test("diagnostics route authenticates, bounds input and checks repository access", async () => {
	const { handleRequest } = await import("./handler.ts");
	const request = (body: unknown) =>
		new Request("https://lixray.com/api/repository-open-diagnostics", {
			method: "POST",
			headers: { authorization: "Bearer test" },
			body: JSON.stringify(body),
		});
	const env = {
		POSTHOG_PROJECT_TOKEN: "project-token",
		POSTHOG_ENVIRONMENT: "production",
	};
	const body = { repositoryId: id, diagnostic: {} };
	let delivered = 0;
	const options = {
		authenticate: async () => ({
			ok: true as const,
			auth: { userId: "actor", token: "test" },
		}),
		authorizeLix: async () => null,
		fetch: async () => {
			delivered++;
			return new Response("{}");
		},
	};
	assert.equal((await handleRequest(request(body), env, options)).status, 200);
	assert.equal(delivered, 1);
	assert.equal(
		(
			await handleRequest(request(body), env, {
				...options,
				authorizeLix: async () => new Response(null, { status: 403 }),
			})
		).status,
		403,
	);
	assert.equal(
		(
			await handleRequest(
				request({ ...body, extra: "a".repeat(4096) }),
				env,
				options,
			)
		).status,
		413,
	);
	assert.equal(delivered, 1);
});

void test("anonymous reports are accepted only for public repositories", async () => {
	const { handleRequest } = await import("./handler.ts");
	const request = () =>
		new Request("https://lixray.com/api/repository-open-diagnostics", {
			method: "POST",
			body: JSON.stringify({ repositoryId: id, diagnostic: {} }),
		});
	const env = {
		POSTHOG_PROJECT_TOKEN: "project-token",
		POSTHOG_ENVIRONMENT: "production",
	};
	const response = await handleRequest(request(), env, {
		resolvePublicLix: async () => ({ ok: true, lixId: id }),
		fetch: async () => new Response("{}"),
	});
	assert.equal(response.status, 200);
	const denied = await handleRequest(request(), env, {
		resolvePublicLix: async () => ({
			ok: false,
			response: new Response(null, { status: 404 }),
		}),
	});
	assert.equal(denied.status, 404);
});
