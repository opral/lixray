import { chromium } from "@playwright/test";
import { performance } from "node:perf_hooks";

const baseUrl = process.env.PROFILE_BASE_URL ?? "http://127.0.0.1:8787";
const reloadRuns = Number(process.env.PROFILE_RELOAD_RUNS ?? 5);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const phases = [];
let activePhase = null;
const requestStarts = new WeakMap();

page.on("request", (request) => {
	if (!activePhase) return;
	requestStarts.set(request, performance.now());
});

page.on("requestfinished", (request) => {
	if (!activePhase) return;
	recordRequest(activePhase, request, null);
});

page.on("requestfailed", (request) => {
	if (!activePhase) return;
	recordRequest(activePhase, request, request.failure()?.errorText ?? "failed");
});

await page.addInitScript(() => {
	window.__lixrayProfile = {
		openingWorkspaceAppearances: 0,
		longTasks: [],
	};

	const observeOpeningState = () => {
		let wasOpening = false;
		const sample = () => {
			const isOpening =
				document.body?.textContent?.includes("Opening repository…") ?? false;
			if (isOpening && !wasOpening) {
				window.__lixrayProfile.openingWorkspaceAppearances += 1;
			}
			wasOpening = isOpening;
		};
		new MutationObserver(sample).observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		sample();
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", observeOpeningState, {
			once: true,
		});
	} else {
		observeOpeningState();
	}

	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				window.__lixrayProfile.longTasks.push({
					start: entry.startTime,
					duration: entry.duration,
				});
			}
		}).observe({ type: "longtask", buffered: true });
	} catch {
		// Long-task entries are not exposed by every Chromium build.
	}
});

await runPhase("sign-in-and-first-open", async () => {
	await page.goto(`${baseUrl}/sign-in`);
	await page
		.getByRole("button", { name: "Continue as local developer" })
		.click();
	await waitForWorkspace(page);
});

const workspaceUrl = page.url();
const fileName = await ensureMarkdownFile(page);
await switchToHome(page);

for (let run = 1; run <= reloadRuns; run += 1) {
	await runPhase(`workspace-reload-${run}`, async () => {
		await page.goto(workspaceUrl);
		await waitForWorkspace(page);
	});
}

await ensureFileTabOpen(page, fileName);
await switchToHome(page);

await runPhase("switch-home-to-open-file-tab", async () => {
	await page.getByRole("button", { name: fileName, exact: true }).click();
	await waitForActiveTab(page, fileName);
	await waitForMarkdownEditor(page);
});

await runPhase("switch-file-to-home-tab", async () => {
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await waitForActiveTab(page, "Home");
	await page.getByTestId("home-new-button").waitFor({ state: "visible" });
});

await ensureFileTabOpen(page, fileName);
await runPhase("close-file-tab", async () => {
	const fileTab = page.getByRole("button", { name: fileName, exact: true });
	await fileTab.locator("svg").last().click();
	await fileTab.waitFor({ state: "detached" });
	await waitForActiveTab(page, "Home");
});

await runPhase("reopen-closed-file-tab", async () => {
	const recentFile = page
		.getByRole("button")
		.filter({ hasText: new RegExp(`^${escapeRegex(fileName)}`) })
		.last();
	await recentFile.click();
	await waitForActiveTab(page, fileName);
	await waitForMarkdownEditor(page);
});

const backgroundPage = await context.newPage();
await backgroundPage.goto("about:blank");
await runPhase("browser-tab-background-and-return", async () => {
	await backgroundPage.bringToFront();
	await page.waitForTimeout(1_000);
	await page.bringToFront();
	await waitForActiveTab(page, fileName);
	await waitForMarkdownEditor(page);
});

console.log(
	JSON.stringify(
		{
			baseUrl,
			workspaceUrl,
			fileName,
			reloadRuns,
			phases: phases.map(summarizePhase),
		},
		null,
		2,
	),
);

await browser.close();

async function runPhase(name, action) {
	const openingBefore = await openingAppearances();
	const longTasksBefore = await browserLongTasks();
	const phase = {
		name,
		startedAt: performance.now(),
		requests: [],
		openingBefore,
		longTasksBefore,
	};
	activePhase = phase;
	let actionFinishedAt;
	try {
		await action();
		actionFinishedAt = performance.now();
		await page.waitForTimeout(100);
	} finally {
		phase.durationMs =
			(actionFinishedAt ?? performance.now()) - phase.startedAt;
		phase.openingAfter = await openingAppearances();
		phase.longTasksAfter = await browserLongTasks();
		activePhase = null;
		phases.push(phase);
	}
}

async function openingAppearances() {
	return page
		.evaluate(() => window.__lixrayProfile?.openingWorkspaceAppearances ?? 0)
		.catch(() => 0);
}

async function browserLongTasks() {
	return page
		.evaluate(() => window.__lixrayProfile?.longTasks ?? [])
		.catch(() => []);
}

function recordRequest(phase, request, failure) {
	const resourceType = request.resourceType();
	if (!["document", "fetch", "xhr"].includes(resourceType)) return;
	const url = new URL(request.url());
	const timing = request.timing();
	phase.requests.push({
		method: request.method(),
		path: url.pathname,
		resourceType,
		...(url.pathname.endsWith("/execute")
			? { postData: request.postData() }
			: {}),
		durationMs:
			timing.responseEnd >= 0 && timing.startTime >= 0
				? timing.responseEnd
				: Math.max(0, performance.now() - (requestStarts.get(request) ?? 0)),
		failure,
	});
}

function summarizePhase(phase) {
	const lixRequests = phase.requests.filter((request) =>
		request.path.includes("/lix/v1"),
	);
	const routeResolutionRequests = phase.requests.filter((request) =>
		/request_workspace|workspace.*route|resolve/i.test(request.path),
	);
	const longTasks =
		phase.longTasksAfter.length >= phase.longTasksBefore.length
			? phase.longTasksAfter.slice(phase.longTasksBefore.length)
			: phase.longTasksAfter;
	return {
		name: phase.name,
		durationMs: round(phase.durationMs),
		openingWorkspaceAppearances:
			phase.openingAfter >= phase.openingBefore
				? phase.openingAfter - phase.openingBefore
				: phase.openingAfter,
		requestCount: phase.requests.length,
		lixRequestCount: lixRequests.length,
		lixRequests: lixRequests.map(compactRequest),
		routeResolutionRequests: routeResolutionRequests.map(compactRequest),
		longTasks: {
			count: longTasks.length,
			totalDurationMs: round(
				longTasks.reduce((total, task) => total + task.duration, 0),
			),
			maxDurationMs: round(
				longTasks.reduce(
					(maximum, task) => Math.max(maximum, task.duration),
					0,
				),
			),
		},
		requests: phase.requests.map(compactRequest),
	};
}

function compactRequest(request) {
	return {
		method: request.method,
		path: request.path,
		durationMs: round(request.durationMs),
		...(request.postData ? { postData: request.postData } : {}),
		...(request.failure ? { failure: request.failure } : {}),
	};
}

function round(value) {
	return Math.round(value * 10) / 10;
}

async function waitForWorkspace(targetPage) {
	await targetPage
		.getByRole("button", { name: "Toggle left panel" })
		.waitFor({ state: "visible", timeout: 60_000 });
	await targetPage
		.getByText("Opening repository…", { exact: true })
		.waitFor({ state: "detached", timeout: 60_000 })
		.catch(() => {});
}

async function ensureMarkdownFile(targetPage) {
	await switchToHome(targetPage);
	const existing = targetPage
		.getByRole("button")
		.filter({ hasText: /^untitled\.md/ })
		.last();
	if ((await existing.count()) > 0) return "untitled.md";

	const emptyStateMarkdown = targetPage.getByRole("button", {
		name: "Markdown",
		exact: true,
	});
	if ((await emptyStateMarkdown.count()) > 0) {
		await emptyStateMarkdown.click();
	} else {
		await targetPage.getByTestId("home-new-button").click();
		await targetPage
			.getByRole("button", { name: "New Markdown (.md)", exact: true })
			.click();
	}
	await waitForActiveTab(targetPage, "untitled.md");
	await waitForMarkdownEditor(targetPage);
	return "untitled.md";
}

async function ensureFileTabOpen(targetPage, fileName) {
	const tab = targetPage.getByRole("button", { name: fileName, exact: true });
	if ((await tab.count()) > 0) {
		await tab.click();
		await waitForActiveTab(targetPage, fileName);
		return;
	}
	await switchToHome(targetPage);
	await targetPage
		.getByRole("button")
		.filter({ hasText: new RegExp(`^${escapeRegex(fileName)}`) })
		.last()
		.click();
	await waitForActiveTab(targetPage, fileName);
}

async function switchToHome(targetPage) {
	const home = targetPage.getByRole("button", { name: "Home", exact: true });
	await home.click();
	await waitForActiveTab(targetPage, "Home");
}

async function waitForActiveTab(targetPage, name) {
	await targetPage
		.locator(`button[aria-label="${name}"][data-active="true"]`)
		.waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForMarkdownEditor(targetPage) {
	await targetPage
		.locator(".ProseMirror[contenteditable=true]")
		.waitFor({ state: "visible", timeout: 30_000 });
}

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
