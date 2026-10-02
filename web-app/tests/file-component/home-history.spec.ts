import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		homeHistoryQA: {
			renders: Array<{
				branch: string;
				hasSource: boolean;
				count: number | null | undefined;
			}>;
			removeSource: () => void;
			hold: () => void;
			localQueries: string[];
			historyQueries: Array<{ branch: string; sql: string }>;
			acquisitions: () => number;
			release: () => void;
			switchBranch: () => void;
		};
	}
}

test("local working summary is ready while authoritative history is pending", async ({
	page,
}) => {
	await page.goto("/home-history.html");
	await expect(page.getByTestId("summary")).toContainText(
		'"workingFileCount":3',
	);
	await expect
		.poll(() => page.evaluate(() => window.homeHistoryQA.acquisitions()))
		.toBe(2);
	expect(
		await page.evaluate(() => window.homeHistoryQA.historyQueries),
	).toEqual([]);
	expect(
		await page.evaluate(() => window.homeHistoryQA.localQueries),
	).not.toEqual(
		expect.arrayContaining([expect.stringMatching(/lix_change|lix_log\(/)]),
	);
	await page.evaluate(() => window.homeHistoryQA.release());
	await expect(page.getByTestId("summary")).toContainText(
		'"totalChangeCount":42',
	);
	await expect(page.getByTestId("summary")).toContainText(
		'"checkpointCount":7',
	);
});

test("branch adoption cancels pending history acquisition before its query starts", async ({
	page,
}) => {
	await page.goto("/home-history.html");
	await expect
		.poll(() => page.evaluate(() => window.homeHistoryQA.acquisitions()))
		.toBe(2);
	await page.evaluate(() => window.homeHistoryQA.switchBranch());
	await expect
		.poll(() => page.evaluate(() => window.homeHistoryQA.acquisitions()))
		.toBe(4);
	await page.evaluate(() => window.homeHistoryQA.release());
	await expect(page.getByTestId("summary")).toContainText(
		'"totalChangeCount":84',
	);
	expect(
		await page.evaluate(() =>
			window.homeHistoryQA.historyQueries.map(({ branch }) => branch),
		),
	).toEqual(["b", "b"]);
});

test("a view without an authorized history source never falls back to local inventory", async ({
	page,
}) => {
	await page.goto("/home-history.html?no-source");
	await expect(page.getByTestId("summary")).toContainText(
		'"workingFileCount":3',
	);
	await expect(page.getByTestId("summary")).toContainText(
		'"changeHistoryUnavailable":true',
	);
	expect(await page.evaluate(() => window.homeHistoryQA.acquisitions())).toBe(
		0,
	);
	expect(
		await page.evaluate(() => window.homeHistoryQA.localQueries),
	).not.toEqual(
		expect.arrayContaining([expect.stringMatching(/lix_change|lix_log\(/)]),
	);
});

test("history rows disappear on the first render after branch or capability changes", async ({
	page,
}) => {
	await page.goto("/home-history.html");
	await page.evaluate(() => window.homeHistoryQA.release());
	await expect(page.getByTestId("summary")).toContainText(
		'"totalChangeCount":42',
	);
	await page.evaluate(() => {
		window.homeHistoryQA.hold();
		window.homeHistoryQA.switchBranch();
	});
	await expect
		.poll(() => page.evaluate(() => window.homeHistoryQA.acquisitions()))
		.toBe(4);
	await expect(page.getByTestId("summary")).toContainText(
		'"totalChangeCount":null',
	);
	expect(
		await page.evaluate(() =>
			window.homeHistoryQA.renders
				.filter((row) => row.branch === "b")
				.map((row) => row.count),
		),
	).not.toContain(42);
	await page.evaluate(() => window.homeHistoryQA.release());
	await expect(page.getByTestId("summary")).toContainText(
		'"totalChangeCount":84',
	);
	await page.evaluate(() => window.homeHistoryQA.removeSource());
	await expect(page.getByTestId("summary")).toContainText(
		'"totalChangeCount":null',
	);
	expect(
		await page.evaluate(() =>
			window.homeHistoryQA.renders
				.filter((row) => !row.hasSource)
				.map((row) => row.count),
		),
	).not.toContain(84);
});
