import assert from "node:assert/strict";
import test from "node:test";
import {
	reportUserSignedUp,
	SIGNUP_TELEMETRY_PATH,
	signupTelemetryContext,
} from "./signup-telemetry.ts";

void test("signup telemetry uses one event context across web and MCP", () => {
	assert.deepEqual(signupTelemetryContext("/open"), {
		surface: "web",
		source: "direct",
	});
	assert.deepEqual(
		signupTelemetryContext(
			"/oauth/consent?authorization_id=secret-authorization-id",
		),
		{ surface: "mcp", source: "oauth" },
	);
	assert.deepEqual(signupTelemetryContext("/repository?id=secret"), {
		surface: "web",
		source: "other",
	});
});

void test("signup telemetry posts the access token without user PII", async () => {
	let capturedRequest: Request | undefined;
	await reportUserSignedUp(
		{ access_token: "access-token" },
		"/oauth/consent?authorization_id=secret",
		async (input, init) => {
			const inputUrl =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			capturedRequest = new Request(
				new URL(inputUrl, "http://localhost"),
				init,
			);
			return Response.json({ captured: true });
		},
	);

	assert.equal(
		capturedRequest?.url,
		`http://localhost${SIGNUP_TELEMETRY_PATH}`,
	);
	assert.equal(
		capturedRequest?.headers.get("authorization"),
		"Bearer access-token",
	);
	assert.deepEqual(await capturedRequest?.json(), {
		surface: "mcp",
		source: "oauth",
	});
});

void test("signup telemetry reports server delivery failures", async () => {
	let attempts = 0;
	await assert.rejects(
		reportUserSignedUp({ access_token: "token" }, "/open", async () => {
			attempts++;
			return Response.json({ captured: false }, { status: 502 });
		}),
		/Signup telemetry failed \(502\)/,
	);
	assert.equal(attempts, 2);
});

void test("signup telemetry retries a lost server response", async () => {
	let attempts = 0;
	await reportUserSignedUp({ access_token: "token" }, "/open", async () => {
		attempts++;
		return attempts === 1
			? Response.json({ captured: false }, { status: 502 })
			: Response.json({ captured: true });
	});
	assert.equal(attempts, 2);
});
