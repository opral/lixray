import assert from "node:assert/strict";
import test from "node:test";
import {
	SESSION_RECORDING_BLOCK_SELECTOR,
	sanitizeLixrayPathname,
	scrubPostHogEvent,
} from "./telemetry-privacy.ts";

void test("canonicalizes private Lixray routes for Web Analytics", () => {
	assert.equal(
		sanitizeLixrayPathname("/@samuel/customer-roadmap/file/private/plan.md"),
		"/repository/:repository/file/:file",
	);
	assert.equal(
		sanitizeLixrayPathname("/@samuel/customer-roadmap?branch=secret"),
		"/repository/:repository",
	);
	assert.equal(sanitizeLixrayPathname("/sign-in"), "/sign-in");
});

void test("scrubs URLs, referrers, tokens, and sensitive explicit properties", () => {
	const event = scrubPostHogEvent({
		uuid: "event_1",
		event: "$pageview",
		properties: {
			$current_url:
				"https://lixray.com/@samuel/customer-roadmap/file/private/plan.md?branch=secret",
			$pathname: "/@samuel/customer-roadmap/file/private/plan.md",
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

void test("preserves sanitized PostHog exception messages", () => {
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
								vars: { value: "private document content" },
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
				value: "The lix is recovering at [redacted_path] and Bearer [redacted]",
				mechanism: { handled: true },
				stacktrace: {
					frames: [
						{
							filename: "[redacted_path]",
							vars: {},
						},
					],
				},
			},
		],
	});
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
