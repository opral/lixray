import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./handler.ts";

const endpoint = "https://lixray.com/api/telemetry/browser/otlp/v1/traces";
const repositoryId = "01920000-0000-7000-8000-000000000001";

void test("browser OTLP route requires a repository ID and authenticated access", async () => {
	const noActiveRepository = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			body: new Uint8Array(),
		}),
		{},
	);
	assert.equal(noActiveRepository.status, 204);

	const unauthorized = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer bad-token",
				"x-lixray-repository-id": repositoryId,
			},
			body: new Uint8Array(),
		}),
		{},
		{
			authenticate: async () => ({
				ok: false,
				response: new Response("Unauthorized", { status: 401 }),
			}),
			fetch: async () => {
				assert.fail("unauthenticated telemetry must not reach PostHog");
			},
		},
	);
	assert.equal(unauthorized.status, 401);
});

void test("browser OTLP route authorizes the repository and forwards standard OTLP", async () => {
	const calls: Array<{ url: URL; authorization: string | null }> = [];
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer user-token",
				"content-type": "application/x-protobuf",
				"x-lixray-repository-id": repositoryId,
			},
			body: new Uint8Array(),
		}),
		{
			POSTHOG_PROJECT_TOKEN: "phc_project-token",
			POSTHOG_ENVIRONMENT: "production",
		},
		{
			authenticate: async () => ({
				ok: true,
				auth: { userId: "account-1", token: "user-token" },
			}),
			authorizeLix: async (id) => {
				assert.equal(id, repositoryId);
				return null;
			},
			fetch: async (input, init) => {
				calls.push({
					url: new URL(input.toString()),
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return new Response(new Uint8Array(), { status: 200 });
			},
		},
	);

	assert.equal(response.status, 200);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url.pathname, "/i/v1/traces");
	assert.equal(calls[0]?.authorization, "Bearer phc_project-token");
});

void test("browser OTLP route rejects repository access before forwarding", async () => {
	const response = await handleRequest(
		new Request(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer user-token",
				"x-lixray-repository-id": repositoryId,
			},
			body: new Uint8Array(),
		}),
		{},
		{
			authenticate: async () => ({
				ok: true,
				auth: { userId: "account-1", token: "user-token" },
			}),
			authorizeLix: async () => new Response("Forbidden", { status: 403 }),
			fetch: async () => {
				assert.fail("unauthorized repository telemetry must not reach PostHog");
			},
		},
	);
	assert.equal(response.status, 403);
});
