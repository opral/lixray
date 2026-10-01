import assert from "node:assert/strict";
import test from "node:test";
import {
	SESSION_RECORDING_BLOCK_SELECTOR,
	safeCrossOriginScriptOrigins,
	sanitizeLixrayPathname,
	scrubPostHogEvent,
} from "./telemetry-privacy.ts";

void test("canonicalizes private Lixray routes for Web Analytics", () => {
	assert.equal(
		sanitizeLixrayPathname(
			"/@samuel/customer-roadmap/file/ERERERERQRGBEREREREREQ/plan.md",
		),
		"/repository/:repository/file/:file",
	);
	assert.equal(
		sanitizeLixrayPathname("/@samuel/customer-roadmap?branch=secret"),
		"/repository/:repository",
	);
	assert.equal(
		sanitizeLixrayPathname("/profile/33333333-3333-4333-8333-333333333333"),
		"/profile/:namespace",
	);
	assert.equal(sanitizeLixrayPathname("/sign-in"), "/sign-in");
});

void test("scrubs URLs, referrers, tokens, and sensitive explicit properties", () => {
	const event = scrubPostHogEvent({
		uuid: "event_1",
		event: "$pageview",
		properties: {
			$current_url:
				"https://lixray.com/@samuel/customer-roadmap/file/ERERERERQRGBEREREREREQ/plan.md?branch=secret",
			$pathname:
				"/@samuel/customer-roadmap/file/ERERERERQRGBEREREREREQ/plan.md",
			$referrer: "https://search.example/results?q=private",
			file_path: "/private/plan.md",
			invite_token: "invite-secret",
			note: "Bearer secret-token",
		},
	});

	assert.deepEqual(event?.properties, {
		$current_url: "https://lixray.com/repository/:repository/file/:file",
		$pathname: "/repository/:repository/file/:file",
		$referrer: "https://search.example",
		note: "Bearer [redacted]",
	});
});

void test("autocapture keeps only intentional safe data attributes", () => {
	const event = scrubPostHogEvent({
		uuid: "event_2",
		event: "$autocapture",
		properties: {
			$el_text: "Customer roadmap",
			$external_click_url: "https://example.com/private",
			"attr__aria-label": "Open private/plan.md",
			"attr__data-testid": "private-plan",
			"attr__data-attr": "markdown-format-bold",
			$elements: [
				{
					$el_text: "plan.md",
					attr__title: "plan.md",
					"attr__data-attr": "file-tree",
				},
			],
		},
	});

	assert.deepEqual(event?.properties, {
		"attr__data-attr": "markdown-format-bold",
		$elements: [{ "attr__data-attr": "file-tree" }],
	});
});

void test("scrubs personal API tokens from telemetry strings", () => {
	const token = `lixray_pat_${"a".repeat(64)}`;
	const event = scrubPostHogEvent({
		uuid: "api_token_event",
		event: "$exception",
		properties: {
			note: `Credential ${token}`,
			header: `Bearer ${token}`,
			diagnostic: "api_key=private-value",
		},
	});
	assert.deepEqual(event?.properties, {
		note: "Credential [redacted_token]",
		header: "Bearer [redacted]",
		diagnostic: "api_key=[redacted]",
	});
});

void test("redacts native PostHog messages while preserving sanitized frames", () => {
	const event = scrubPostHogEvent({
		uuid: "event_exception",
		event: "$exception",
		properties: {
			$exception_list: [
				{
					type: "LixError",
					value:
						"The lix is recovering at /Users/samuel/private and Bearer secret-token",
					mechanism: { handled: true },
					stacktrace: {
						frames: [
							{
								filename: "file:///Users/samuel/private/protocol.ts",
							},
							{
								filename:
									"https://assets.example/app.js?token=private#repository-content",
								function: "openRepository",
								lineno: 23,
								colno: 11,
								in_app: true,
								chunk_id: "11111111-1111-4111-8111-111111111111",
							},
						],
					},
				},
			],
		},
	});

	assert.deepEqual(event?.properties, {
		$exception_list: [
			{
				type: "LixError",
				value: "LixError",
				mechanism: { handled: true },
				stacktrace: {
					frames: [
						{
							filename: "[redacted_path]",
						},
						{
							filename: "https://assets.example/app.js",
							function: "openRepository",
							lineno: 23,
							colno: 11,
							in_app: true,
							chunk_id: "11111111-1111-4111-8111-111111111111",
						},
					],
				},
			},
		],
	});
});

void test("native PostHog exceptions keep a safe code and frames but omit messages", () => {
	const event = scrubPostHogEvent({
		uuid: "event_native_exception",
		event: "$exception",
		properties: {
			lix_error_code: "LIX_SQL_QUERY_FAILED",
			lix_error_hint: "SELECT private contents FROM repository_files",
			$exception_list: [
				{
					type: "LixError",
					value:
						"Planning failed at /home/private/worktree; SELECT secret FROM private_table",
					mechanism: { handled: true },
					stacktrace: {
						frames: [
							{
								filename: "https://lixray.com/assets/query-A1.js?token=secret",
								function: "runQuery",
								lineno: 23,
								colno: 17,
								in_app: true,
								chunk_id: "11111111-1111-4111-8111-111111111111",
							},
						],
					},
				},
				{
					type: "StorageError",
					value: "Unable to open /private/customer/repository",
					mechanism: { handled: true },
				},
			],
		},
	});
	const properties = event?.properties as Record<string, unknown>;
	const exceptions = properties.$exception_list as Array<{
		type: string;
		value: string;
		stacktrace?: { frames: Array<Record<string, unknown>> };
	}>;
	assert.equal(properties.lix_error_code, "LIX_SQL_QUERY_FAILED");
	assert.equal(properties.lix_error_hint, undefined);
	assert.equal(exceptions[0]!.type, "LIX_SQL_QUERY_FAILED");
	assert.equal(exceptions[0]!.value, "LIX_SQL_QUERY_FAILED");
	assert.equal(exceptions[1]!.value, "Caused by StorageError");
	assert.deepEqual(exceptions[0]!.stacktrace?.frames[0], {
		filename: "https://lixray.com/assets/query-A1.js",
		function: "runQuery",
		lineno: 23,
		colno: 17,
		in_app: true,
		chunk_id: "11111111-1111-4111-8111-111111111111",
	});
	assert.doesNotMatch(
		JSON.stringify(properties),
		/private_table|secret FROM|private\/worktree|customer\/repository|private contents/,
	);
});

void test("classifies opaque cross-origin exceptions without dropping them", () => {
	const event = scrubPostHogEvent({
		uuid: "event_opaque_exception",
		event: "$exception",
		properties: {
			$exception_list: [
				{
					type: "Error",
					value: "Script error.",
					mechanism: { handled: false, synthetic: true },
				},
			],
			$exception_sources: [],
		},
	});

	assert.deepEqual(event?.properties, {
		$exception_list: [
			{
				type: "Error",
				value: "Script error.",
				mechanism: { handled: false, synthetic: true },
			},
		],
		$exception_sources: [],
		lixray_exception_context_quality: "opaque_cross_origin",
	});
});

void test("does not misclassify exceptions that contain a stack", () => {
	const event = scrubPostHogEvent({
		uuid: "event_script_error_with_stack",
		event: "$exception",
		properties: {
			$exception_list: [
				{
					value: "Script error.",
					stacktrace: { frames: [{ filename: "/assets/app.js" }] },
				},
			],
		},
	});

	assert.deepEqual(event?.properties, {
		$exception_list: [
			{
				value: "Script error.",
				stacktrace: { frames: [{ filename: "/assets/app.js" }] },
			},
		],
	});
});

void test("scrubs SQL and response bodies from bounded exception diagnostics", () => {
	const event = scrubPostHogEvent({
		uuid: "event_content_bearing_exception",
		event: "$exception",
		properties: {
			$exception_list: [
				{
					type: "LixError",
					value:
						"Repository read failed: SELECT private_column FROM secret_repository",
					stacktrace: {
						frames: [
							{
								filename:
									"https://assets.example/app.js?token=private#document-content",
								function: "loadRepository",
								code: "SELECT * FROM private_table",
								vars: { document: "private repository content" },
							},
						],
					},
				},
			],
			lix_error_code: "LIX_READ_FAILED",
			response_body: "private response body",
			"http.response.body": '{"document":"private repository content"}',
			response_diagnostic: 'Response body: {"secret":"private response"}',
			long_message: `Request failed ${"x".repeat(20_000)}`,
		},
	});
	const properties = event?.properties as Record<string, unknown>;
	const exception = (
		properties.$exception_list as Array<Record<string, unknown>>
	)[0]!;
	const frames = (
		exception.stacktrace as { frames: Array<Record<string, unknown>> }
	).frames;
	assert.equal(exception.value, "LIX_READ_FAILED");
	assert.equal(properties.lix_error_code, "LIX_READ_FAILED");
	assert.equal(properties.response_body, undefined);
	assert.equal(properties["http.response.body"], undefined);
	assert.equal(properties.response_diagnostic, "[response body omitted]");
	assert.equal((properties.long_message as string).length, 16_384);
	assert.deepEqual(frames[0], {
		filename: "https://assets.example/app.js",
		function: "loadRepository",
		code: "[SQL statement omitted]",
	});
	assert.doesNotMatch(
		JSON.stringify(properties),
		/private_column|secret_repository|private_table|private repository content|private response/,
	);
});

void test("retains only safe HTTP origins when inventorying external scripts", () => {
	assert.deepEqual(
		safeCrossOriginScriptOrigins(
			[
				"/assets/app.js",
				"https://cdn.example/extension.js?repository=private",
				"https://cdn.example/other.js",
				"safari-web-extension://private-extension-id/injected.js",
			],
			"https://lixray.com/",
			"https://lixray.com",
		),
		["https://cdn.example"],
	);
});

void test("session replay blocks rich document content surfaces", () => {
	for (const selector of [
		"[data-attr='markdown-editor']",
		".atelier-image-canvas",
		"img",
		"iframe",
		"canvas",
	]) {
		assert.match(
			SESSION_RECORDING_BLOCK_SELECTOR,
			new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	}
});
