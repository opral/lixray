import { chromium } from "@playwright/test";

// Read-only: an existing authenticated Playwright storage state can be supplied.
// Neither document contents, credentials, SQL parameters, nor resource IDs are printed.
const url = process.env.PROFILE_URL;
if (!url) throw new Error("Set PROFILE_URL to an existing document URL");
const timeout = Number(process.env.PROFILE_TIMEOUT_MS ?? 60000);
const runs = Number(process.env.PROFILE_RUNS ?? 2);
if (
	!Number.isFinite(timeout) ||
	timeout <= 0 ||
	!Number.isSafeInteger(runs) ||
	runs < 1 ||
	runs > 20
)
	throw new Error("Invalid profile limits");
const browser = await chromium.launch({
	headless: process.env.PROFILE_HEADLESS !== "false",
});
const context = await browser.newContext({
	storageState: process.env.PROFILE_STORAGE_STATE || undefined,
});
const page = await context.newPage();
await page.addInitScript(() => {
	window.__documentOpenProfile = { longTasks: [], loadingSeen: false };
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries())
			window.__documentOpenProfile.longTasks.push({
				start: entry.startTime,
				ms: entry.duration,
			});
	}).observe({ type: "longtask", buffered: true });
	document.addEventListener("DOMContentLoaded", () => {
		const sample = () => {
			if (document.querySelector("[data-atelier-document-loading]"))
				window.__documentOpenProfile.loadingSeen = true;
		};
		new MutationObserver(sample).observe(document.body, {
			childList: true,
			subtree: true,
		});
		sample();
	});
});
let phase;
const starts = new WeakMap();
page.on("request", (request) =>
	starts.set(request, { start: performance.now(), phase }),
);
const record = async (request, failed) => {
	const started = starts.get(request);
	if (!started?.phase) return;
	const path = new URL(request.url()).pathname;
	const kind = path.includes("/sync/")
		? "sync"
		: path.endsWith("/admission")
			? "admission"
			: path.includes("/lix/")
				? "lix"
				: path.startsWith("/assets/")
					? "asset"
					: path.includes("/rest/")
						? "catalog"
						: "other";
	started.phase.requests.push({
		kind,
		method: request.method(),
		ms: Math.round(performance.now() - started.start),
		status: (await request.response().catch(() => null))?.status() ?? null,
		failed,
	});
};
page.on("requestfinished", (request) => void record(request, false));
page.on("requestfailed", (request) => void record(request, true));
const results = [];
try {
	for (let run = 0; run < runs; run++) {
		phase = {
			run,
			cache: run === 0 ? "fresh browser context" : "same context reload",
			requests: [],
		};
		results.push(phase);
		const start = performance.now();
		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout });
		} catch {
			// Browser navigation exceptions may contain the private document URL.
			phase.outcome = "navigation-failed";
			phase.elapsedMs = Math.round(performance.now() - start);
			process.exitCode = 1;
			break;
		}
		try {
			await page.waitForFunction(
				() => {
					const error = document.querySelector('[role="alert"]');
					const unavailable = document.body.innerText.includes(
						"This file isn't available",
					);
					const ready = [
						...document.querySelectorAll(
							'[data-atelier-document-surface] canvas, [data-atelier-document-surface] .csv-review-table, [data-atelier-document-surface] .tiptap, [data-atelier-document-surface] [contenteditable="true"]',
						),
					].some(
						(el) =>
							!el.closest('[aria-hidden="true"]') &&
							el.getBoundingClientRect().height > 0,
					);
					return ready || error || unavailable;
				},
				null,
				{ timeout },
			);
			phase.outcome = await page.evaluate(() =>
				document.body.innerText.includes("This file isn't available")
					? "authentication-or-access-required"
					: document.querySelector('[role="alert"]')
						? "error"
						: "interactive",
			);
		} catch {
			phase.outcome = "timeout";
		}
		phase.elapsedMs = Math.round(performance.now() - start);
		Object.assign(
			phase,
			await page.evaluate(() => window.__documentOpenProfile),
		);
		if (phase.outcome !== "interactive") {
			process.exitCode = 1;
			break;
		}
	}
} finally {
	await browser.close();
	console.log(
		JSON.stringify({ profile: "document-open-browser", results }, null, 2),
	);
}
