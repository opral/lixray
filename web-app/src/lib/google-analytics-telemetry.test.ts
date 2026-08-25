import assert from "node:assert/strict";
import test from "node:test";
import { addGoogleAnalytics } from "./google-analytics.ts";

void test("adds the privacy-limited Google tag to the landing page", async () => {
	const response = await addGoogleAnalytics(
		new Request("https://lixray.com/"),
		new Response(
			"<html><head><title>LixRay</title></head><body></body></html>",
			{
				headers: { "content-type": "text/html; charset=utf-8" },
			},
		),
		" G-TB0B5Q9D8Z ",
	);
	const html = await response.text();

	assert.match(html, /googletagmanager\.com\/gtag\/js\?id=G-TB0B5Q9D8Z/);
	assert.match(html, /crossorigin="anonymous"/);
	assert.match(html, /gtag\("config","G-TB0B5Q9D8Z"/);
	assert.match(html, /allow_google_signals:false/);
	assert.match(html, /allow_ad_personalization_signals:false/);
	assert.ok(html.indexOf("googletagmanager.com") < html.indexOf("</head>"));
});

void test("does not add the Google tag outside the landing page", async () => {
	const original = new Response("<html><head></head><body></body></html>", {
		headers: { "content-type": "text/html" },
	});
	const response = await addGoogleAnalytics(
		new Request("https://lixray.com/repository"),
		original,
		"G-TB0B5Q9D8Z",
	);

	assert.strictEqual(response, original);
});

void test("ignores missing or malformed measurement IDs", async () => {
	for (const measurementId of [undefined, "", "not-a-measurement-id"]) {
		const original = new Response("<html><head></head><body></body></html>", {
			headers: { "content-type": "text/html" },
		});
		const response = await addGoogleAnalytics(
			new Request("https://lixray.com/"),
			original,
			measurementId,
		);

		assert.strictEqual(response, original);
	}
});
