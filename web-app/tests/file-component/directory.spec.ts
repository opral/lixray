import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

type QAState = {
	dirs: { path: string }[];
	files: { path: string }[];
	calls: { sql: string; params: unknown[] }[];
	opened: { path: string; options: { newTab: boolean } }[];
	diffOpened: string[];
	refresh: () => void;
	setActive: (active: boolean) => void;
	setWriteDelay: (ms: number) => void;
	failNextWrite: () => void;
};
declare global {
	interface Window {
		directoryQA: QAState;
	}
}
const item = (page: Page, name: string) =>
	page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
const selected = (page: Page) => page.getByRole("row", { selected: true });
const checkbox = (page: Page, name: string) =>
	item(page, name).locator("label");
const selectionActions = (page: Page) =>
	page.getByRole("toolbar", { name: "Selection actions" });
async function moreAction(page: Page, name: string) {
	await selectionActions(page).getByRole("button", { name: /More/ }).click();
	await page.getByRole("menuitem", { name, exact: true }).click();
}

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/");
	await expect(page.getByText("alpha.md", { exact: true })).toBeVisible();
});

test.afterEach(async ({ page }) => {
	expect(browserErrors.get(page), "No browser runtime errors").toEqual([]);
});

test("checkbox multi-selection never opens entries and supports select all and clearing", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await checkbox(page, "beta.md").click();
	await expect(selected(page)).toHaveCount(2);
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
	const toolbar = selectionActions(page);
	await expect(
		toolbar.getByRole("checkbox", {
			name: "Select all files and folders",
			exact: true,
		}),
	).toBeChecked({ indeterminate: true });
	await toolbar.getByRole("button", { name: /More/ }).click();
	await expect(page.getByRole("menuitem", { name: /Select all/ })).toHaveCount(
		0,
	);
	await page.keyboard.press("Escape");
	await toolbar.locator("label").click();
	await expect(selected(page)).toHaveCount(5);
	await expect(
		toolbar.getByRole("checkbox", {
			name: "Deselect all files and folders",
			exact: true,
		}),
	).toBeChecked();
	await toolbar.locator("label").click();
	await expect(selected(page)).toHaveCount(0);
	await expect(toolbar).toHaveCount(0);
	await expect
		.poll(() =>
			page
				.getByTestId("home-entry-list")
				.evaluate((list) => list.contains(document.activeElement)),
		)
		.toBe(true);
	await checkbox(page, "beta.md").click();
	await item(page, "beta.md").focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(selected(page)).toHaveCount(5);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(0);
});

for (const focus of [
	"row checkbox",
	"master checkbox",
	"toolbar action",
	"outside",
	"body",
] as const) {
	test(`Escape clears selection with focus on ${focus} and restores ordinary opening`, async ({
		page,
	}) => {
		await checkbox(page, "alpha.md").click();
		if (focus === "row checkbox")
			await item(page, "alpha.md").getByRole("checkbox").focus();
		else if (focus === "master checkbox")
			await selectionActions(page).getByRole("checkbox").focus();
		else if (focus === "toolbar action")
			await selectionActions(page)
				.getByRole("button", { name: "Move", exact: true })
				.focus();
		else if (focus === "outside")
			await page.getByTestId("current-directory").evaluate((element) => {
				element.tabIndex = 0;
				element.focus();
			});
		else
			await page.evaluate(() =>
				(document.activeElement as HTMLElement | null)?.blur(),
			);
		await page.keyboard.press("Escape");
		await expect(selected(page)).toHaveCount(0);
		await expect(selectionActions(page)).toHaveCount(0);
		await item(page, "alpha.md").click();
		expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([
			{ path: "/alpha.md", options: { newTab: false } },
		]);
	});
}

for (const target of ["blank list space", "outside the list"] as const) {
	test(`clicking ${target} clears selection`, async ({ page }) => {
		await checkbox(page, "alpha.md").click();
		await checkbox(page, "beta.md").click();
		if (target === "blank list space") {
			const grid = page.getByTestId("home-entry-list");
			// Exercise a grid with unused space below its rows, as in a taller file pane.
			await grid.evaluate((element) => {
				element.style.paddingBottom = "48px";
			});
			const bounds = await grid.boundingBox();
			await grid.click({
				position: { x: bounds!.width - 8, y: bounds!.height - 8 },
			});
		} else await page.getByTestId("current-directory").click();
		await expect(selected(page)).toHaveCount(0);
		await expect(selectionActions(page)).toHaveCount(0);
		expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
	});
}

test("menu interaction preserves selection and Escape closes the menu before clearing", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await selectionActions(page).getByRole("button", { name: /More/ }).click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Open in new tabs", exact: true })
		.focus();
	await expect(
		page.getByRole("row", { selected: true, includeHidden: true }),
	).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(selected(page)).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(0);
});

test("dialog interactions preserve selection and Escape closes the dialog before clearing", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await page.getByRole("button", { name: "Move", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("grid", { name: "Destination folders" })
		.getByRole("row", { name: "docs", exact: true })
		.click();
	await expect(
		page.getByRole("row", { selected: true, includeHidden: true }),
	).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(selected(page)).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(0);
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) =>
				/^(INSERT|UPDATE|DELETE)/i.test(call.sql),
			),
		),
	).toHaveLength(0);
});

test("checkbox selection supports modifier toggles and contiguous Shift ranges", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await item(page, "gamma.csv").click({ modifiers: ["Shift"] });
	await expect(selected(page)).toHaveCount(3);
	await item(page, "beta.md").click({ modifiers: ["ControlOrMeta"] });
	await expect(selected(page)).toHaveCount(2);
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
	await item(page, "beta.md").click();
	await expect(selected(page)).toHaveCount(3);
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
});

test("Shift-clicking checkboxes selects the inclusive range", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await checkbox(page, "gamma.csv").click({ modifiers: ["Shift"] });
	await expect(selected(page)).toHaveCount(3);
	await item(page, "docs").click({ modifiers: ["Shift"] });
	expect(
		await selected(page).evaluateAll((rows) =>
			rows.map((row) => row.getAttribute("data-path")),
		),
	).toEqual(["/docs", "/research", "/alpha.md"]);
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
});

test("single click and Enter open files and folders without selecting", async ({
	page,
}) => {
	await item(page, "alpha.md").click();
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([
		{ path: "/alpha.md", options: { newTab: false } },
	]);
	await expect(selected(page)).toHaveCount(0);
	await item(page, "docs").click();
	await expect(page.getByTestId("current-directory")).toHaveText("/docs");
	await expect(page.getByText("child.md", { exact: true })).toBeVisible();
	await page.goto("/");
	await checkbox(page, "docs").click();
	await item(page, "docs").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("current-directory")).toHaveText("/docs");
	await expect(page.getByText("child.md", { exact: true })).toBeVisible();
});

test("hover reveals gutter selection without moving content and actions float only after selection", async ({
	page,
}) => {
	const row = item(page, "alpha.md");
	const control = checkbox(page, "alpha.md");
	const name = row.getByText("alpha.md", { exact: true });
	await page.mouse.move(0, 0);
	await expect(control).toHaveCSS("opacity", "0");
	await expect(selectionActions(page)).toHaveCount(0);
	await expect(
		page.getByRole("checkbox", { name: "Select all files and folders" }),
	).toHaveCount(0);
	const before = await name.boundingBox();
	await row.hover();
	await expect(control).toHaveCSS("opacity", "1");
	await control.click();
	await page.mouse.move(0, 0);
	await expect(control).toHaveCSS("opacity", "1");
	await expect(checkbox(page, "beta.md")).toHaveCSS("opacity", "1");
	await expect(selectionActions(page)).toBeVisible();
	await expect(selectionActions(page)).toHaveCSS("position", /fixed|absolute/);
	await expect(
		page.getByRole("button", { name: "Move", exact: true }),
	).toBeVisible();
	const after = await name.boundingBox();
	expect(after!.x).toBeCloseTo(before!.x, 0);
	expect(after!.y).toBeCloseTo(before!.y, 0);
	await page.getByRole("button", { name: "Clear selection" }).click();
	await expect(selectionActions(page)).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Move", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("checkbox", { name: "Select all files and folders" }),
	).toHaveCount(0);
	await page.mouse.move(0, 0);
	await expect
		.poll(() =>
			page
				.getByTestId("home-entry-list")
				.locator("label")
				.evaluateAll((labels) =>
					labels.every((label) => getComputedStyle(label).opacity === "0"),
				),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page
				.getByRole("button", { name: /^Drag / })
				.evaluateAll((buttons) =>
					buttons.every((button) => getComputedStyle(button).opacity === "0"),
				),
		)
		.toBe(true);
});

test("deselecting the last checkbox hides mouse affordances after hover leaves despite retained focus", async ({
	page,
}) => {
	const label = checkbox(page, "alpha.md");
	await label.click();
	await expect(selected(page)).toHaveCount(1);
	await label.click();
	await expect(selected(page)).toHaveCount(0);
	await expect(item(page, "alpha.md").getByRole("checkbox")).toBeFocused();
	await page.mouse.move(0, 0);
	await expect
		.poll(() =>
			page
				.getByTestId("home-entry-list")
				.locator("label")
				.evaluateAll((labels) =>
					labels.every((label) => getComputedStyle(label).opacity === "0"),
				),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page
				.getByRole("button", { name: /^Drag / })
				.evaluateAll((buttons) =>
					buttons.every((button) => getComputedStyle(button).opacity === "0"),
				),
		)
		.toBe(true);
});

test("keyboard focus reveals selection and Space selects without opening", async ({
	page,
}) => {
	await page.mouse.move(0, 0);
	const row = item(page, "docs");
	for (
		let index = 0;
		index < 10 &&
		!(await row.evaluate((element) => element === document.activeElement));
		index++
	)
		await page.keyboard.press("Tab");
	await expect(row).toBeFocused();
	await expect(checkbox(page, "docs")).toHaveCSS("opacity", "1");
	await page.keyboard.press("ArrowRight");
	await expect(row.getByRole("checkbox")).toBeFocused();
	await expect(checkbox(page, "docs")).toHaveCSS("opacity", "1");
	await page.keyboard.press("ArrowLeft");
	await expect(row).toBeFocused();
	await page.keyboard.press("Space");
	await expect(selected(page)).toHaveCount(1);
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
	await page.keyboard.press("Escape");
	await expect(selected(page)).toHaveCount(0);
});

test("touch users can select visibly and tap entries to open", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	try {
		const page = await context.newPage();
		await page.goto("/");
		await expect(checkbox(page, "alpha.md")).toHaveCSS("opacity", "1");
		await checkbox(page, "alpha.md").tap();
		await checkbox(page, "beta.md").tap();
		await expect(selected(page)).toHaveCount(2);
		expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
		await expect(
			page.getByRole("button", { name: "Move", exact: true }),
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		const toolbar = selectionActions(page);
		await expect(
			toolbar.getByRole("checkbox", {
				name: "Select all files and folders",
				exact: true,
			}),
		).toBeChecked({ indeterminate: true });
		const bounds = await toolbar.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
		await toolbar.locator("label").tap();
		await expect(selected(page)).toHaveCount(5);
		await expect(
			toolbar.getByRole("checkbox", {
				name: "Deselect all files and folders",
				exact: true,
			}),
		).toBeChecked();
		await toolbar.locator("label").tap();
		await expect(toolbar).toHaveCount(0);
		await item(page, "docs").tap();
		await expect(page.getByTestId("current-directory")).toHaveText("/docs");
	} finally {
		await context.close();
	}
});

test("new folder requests a focused name before any slow write", async ({
	page,
}) => {
	await page.evaluate(() => window.directoryQA.setWriteDelay(900));
	await page.getByRole("button", { name: "New", exact: true }).click();
	await page.getByRole("menuitem", { name: /folder/i }).click();
	const dialog = page.getByRole("dialog");
	const input = dialog.getByRole("textbox");
	await expect(input).toBeFocused();
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) => /^INSERT/i.test(call.sql)),
		),
	).toHaveLength(0);
	await input.fill("Launch plans");
	await input.press("Enter");
	await expect(page.getByText("Launch plans", { exact: true })).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.directoryQA.dirs.some((dir) => dir.path === "/Launch plans"),
		),
	).toBe(true);
});

test("canceling folder creation leaves the directory untouched", async ({
	page,
}) => {
	await page.getByRole("button", { name: "New", exact: true }).click();
	await page.getByRole("menuitem", { name: /folder/i }).click();
	await expect(page.getByRole("dialog").getByRole("textbox")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "New", exact: true }),
	).toBeFocused();
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) => /^INSERT/i.test(call.sql)),
		),
	).toHaveLength(0);
});

test("selected files drag together into a folder", async ({ page }) => {
	await checkbox(page, "alpha.md").click();
	await checkbox(page, "beta.md").click();
	await item(page, "alpha.md").dragTo(item(page, "docs"));
	await expect
		.poll(() =>
			page.evaluate(() => window.directoryQA.files.map((file) => file.path)),
		)
		.toEqual(expect.arrayContaining(["/docs/alpha.md", "/docs/beta.md"]));
	await expect(page.getByText("alpha.md", { exact: true })).toHaveCount(0);
	await expect(page.getByText("beta.md", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a folder and its descendants move into another folder", async ({
	page,
}) => {
	await item(page, "docs").dragTo(item(page, "research"));
	await expect
		.poll(() =>
			page.evaluate(() => window.directoryQA.dirs.map((dir) => dir.path)),
		)
		.toEqual(
			expect.arrayContaining(["/research/docs", "/research/docs/nested"]),
		);
	expect(
		await page.evaluate(() =>
			window.directoryQA.files.map((file) => file.path),
		),
	).toContain("/research/docs/child.md");
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("read-only directories can open files but expose no mutations", async ({
	page,
}) => {
	await page.goto("/?readonly");
	await expect(page.getByText("alpha.md", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "New", exact: true }),
	).toBeDisabled();
	await item(page, "alpha.md").click();
	expect(
		await page.evaluate(() => window.directoryQA.opened.at(-1)?.path),
	).toBe("/alpha.md");
	await page.keyboard.press("Delete");
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) =>
				/^(INSERT|UPDATE|DELETE)/i.test(call.sql),
			),
		),
	).toHaveLength(0);
});

async function dropNativePaths(page: Page, paths: string[]) {
	const target = await item(page, "docs").boundingBox();
	if (!target) throw new Error("Missing drop target");
	const session = await page.context().newCDPSession(page);
	try {
		for (const type of ["dragEnter", "dragOver", "drop"] as const) {
			await session.send("Input.dispatchDragEvent", {
				type,
				x: target.x + target.width / 2,
				y: target.y + target.height / 2,
				data: { items: [], files: paths, dragOperationsMask: 1 },
			});
		}
	} finally {
		await session.detach();
	}
}

test("external files dropped on a folder import into that folder", async ({
	page,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "lixray-file-drop-"));
	try {
		const path = join(directory, "upload.md");
		await writeFile(path, "Imported");
		await dropNativePaths(page, [path]);
		await expect
			.poll(() =>
				page.evaluate(() => window.directoryQA.files.map((file) => file.path)),
			)
			.toContain("/docs/upload.md");
		expect(
			await page.evaluate(() =>
				window.directoryQA.files.map((file) => file.path),
			),
		).not.toContain("/upload.md");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("external folder drop preserves nested paths and empty folders", async ({
	page,
}) => {
	const directory = await mkdtemp(join(tmpdir(), "lixray-folder-drop-"));
	try {
		const bundle = join(directory, "bundle");
		await mkdir(join(bundle, "nested"), { recursive: true });
		await mkdir(join(bundle, "empty"));
		await writeFile(join(bundle, "nested", "note.md"), "Nested");
		await dropNativePaths(page, [bundle]);
		await expect
			.poll(() =>
				page.evaluate(() => window.directoryQA.files.map((file) => file.path)),
			)
			.toContain("/docs/bundle/nested/note.md");
		expect(
			await page.evaluate(() => window.directoryQA.dirs.map((dir) => dir.path)),
		).toContain("/docs/bundle/empty");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("bulk actions move selected files using the destination picker", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await checkbox(page, "beta.md").click();
	await page.getByRole("button", { name: "Move", exact: true }).click();
	await page
		.getByRole("grid", { name: "Destination folders" })
		.getByRole("row", { name: "research", exact: true })
		.click();
	await page.getByRole("button", { name: "Move here", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.directoryQA.files.map((file) => file.path)),
		)
		.toEqual(
			expect.arrayContaining(["/research/alpha.md", "/research/beta.md"]),
		);
	await expect(selected(page)).toHaveCount(0);
});

test("move destination folders support nested navigation and breadcrumb backtracking", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await page.getByRole("button", { name: "Move", exact: true }).click();
	const dialog = page.getByRole("dialog");
	const folders = dialog.getByRole("grid", { name: "Destination folders" });
	const move = dialog.getByRole("button", { name: "Move here", exact: true });
	await expect(move).toBeDisabled();
	await expect(
		folders.getByRole("row", { name: "nested", exact: true }),
	).toHaveCount(0);
	await folders.getByRole("row", { name: "docs", exact: true }).click();
	await expect(move).toBeEnabled();
	await folders.getByRole("row", { name: "nested", exact: true }).click();
	await expect(move).toBeEnabled();
	await dialog.getByRole("button", { name: "docs", exact: true }).click();
	await expect(
		folders.getByRole("row", { name: "nested", exact: true }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Home", exact: true }).click();
	await expect(move).toBeDisabled();
	await expect(
		folders.getByRole("row", { name: "research", exact: true }),
	).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) =>
				/^(INSERT|UPDATE|DELETE)/i.test(call.sql),
			),
		),
	).toHaveLength(0);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(selected(page)).toHaveCount(1);
	expect(
		await page.evaluate(() =>
			window.directoryQA.files.some((file) => file.path === "/alpha.md"),
		),
	).toBe(true);
});

test("move destinations exclude selected folders and their descendants while empty siblings remain usable", async ({
	page,
}) => {
	await checkbox(page, "docs").click();
	await page.getByRole("button", { name: "Move", exact: true }).click();
	const dialog = page.getByRole("dialog");
	const folders = dialog.getByRole("grid", { name: "Destination folders" });
	await expect(
		folders.getByRole("row", { name: "docs", exact: true }),
	).toHaveCount(0);
	await expect(
		folders.getByRole("row", { name: "nested", exact: true }),
	).toHaveCount(0);
	await folders.getByRole("row", { name: "research", exact: true }).click();
	await expect(folders.locator("[data-key]")).toHaveCount(0);
	await expect(
		dialog.getByText("No folders inside", { exact: true }),
	).toBeVisible();
	await expect(
		dialog.getByText("You can move your items here.", { exact: true }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Move here", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.directoryQA.dirs.map((dir) => dir.path)),
		)
		.toEqual(
			expect.arrayContaining(["/research/docs", "/research/docs/nested"]),
		);
	expect(
		await page.evaluate(() =>
			window.directoryQA.files.some(
				(file) => file.path === "/research/docs/child.md",
			),
		),
	).toBe(true);
});

test("move explains when the selected folder has no valid destination", async ({
	page,
}) => {
	await page.evaluate(() => {
		for (let index = window.directoryQA.dirs.length - 1; index >= 0; index--) {
			if (!window.directoryQA.dirs[index].path.startsWith("/docs"))
				window.directoryQA.dirs.splice(index, 1);
		}
		window.directoryQA.refresh();
	});
	await checkbox(page, "docs").click();
	await page.getByRole("button", { name: "Move", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("button", { name: "Move here", exact: true }),
	).toBeDisabled();
	await expect(
		dialog
			.getByRole("grid", { name: "Destination folders" })
			.locator("[data-key]"),
	).toHaveCount(0);
	await expect(
		dialog.getByText("No other folders available", { exact: true }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) =>
				/^(INSERT|UPDATE|DELETE)/i.test(call.sql),
			),
		),
	).toHaveLength(0);
});

test("bulk delete is cancelable and removes the selected roots after confirmation", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await checkbox(page, "docs").click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Cancel" })
		.click();
	expect(
		await page.evaluate(() =>
			window.directoryQA.files.some((file) => file.path === "/alpha.md"),
		),
	).toBe(true);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(page.getByText("alpha.md", { exact: true })).toHaveCount(0);
	await expect(page.getByText("docs", { exact: true })).toHaveCount(0);
	expect(
		await page.evaluate(() =>
			window.directoryQA.files.some((file) => file.path.startsWith("/docs/")),
		),
	).toBe(false);
});

test("rename collision keeps both entries and permits correcting the name", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await moreAction(page, "Rename");
	const input = page.getByRole("dialog").getByRole("textbox");
	await expect(input).toBeFocused();
	await input.fill("beta.md");
	await input.press("Enter");
	await expect(page.getByRole("alert")).toContainText("already exists");
	await input.fill("renamed.md");
	await input.press("Enter");
	await expect(page.getByText("renamed.md", { exact: true })).toBeVisible();
	expect(
		await page.evaluate(() =>
			window.directoryQA.files.some((file) => file.path === "/beta.md"),
		),
	).toBe(true);
});

test("bulk downloads produce an archive and opening selected items uses new tabs", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await checkbox(page, "beta.md").click();
	await moreAction(page, "Open in new tabs");
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([
		{ path: "/alpha.md", options: { newTab: true } },
		{ path: "/beta.md", options: { newTab: true } },
	]);
	const downloadEvent = page.waitForEvent("download");
	await moreAction(page, "Download");
	const download = await downloadEvent;
	expect(download.suggestedFilename()).toBe("files.zip");
});

test("a failed folder write retains the name and allows retry", async ({
	page,
}) => {
	await page.getByRole("button", { name: "New", exact: true }).click();
	await page.getByRole("menuitem", { name: /folder/i }).click();
	const input = page.getByRole("dialog").getByRole("textbox");
	await input.fill("Retry folder");
	await page.evaluate(() => window.directoryQA.failNextWrite());
	await input.press("Enter");
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(input).toHaveValue("Retry folder");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Create folder" })
		.click();
	await expect(page.getByText("Retry folder", { exact: true })).toBeVisible();
});

test("pending move freezes selection until completion", async ({ page }) => {
	await page.evaluate(() => window.directoryQA.setWriteDelay(1500));
	await checkbox(page, "alpha.md").click();
	await item(page, "alpha.md").dragTo(item(page, "docs"));
	await expect(page.getByText("Working…", { exact: true })).toBeVisible();
	await expect(selectionActions(page).getByRole("checkbox")).toBeDisabled();
	await page.keyboard.press("Escape");
	await page.getByTestId("current-directory").click();
	await item(page, "gamma.csv").click();
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
	await expect(selected(page)).toHaveCount(1);
	await expect
		.poll(() =>
			page.evaluate(() => window.directoryQA.files.map((file) => file.path)),
		)
		.toContain("/docs/alpha.md");
	await expect(selected(page)).toHaveCount(0);
});

test("keyboard shortcuts rename and delete selected entries", async ({
	page,
}) => {
	await checkbox(page, "alpha.md").click();
	await item(page, "alpha.md").focus();
	await page.keyboard.press("F2");
	const input = page.getByRole("dialog").getByRole("textbox");
	await expect(input).toBeFocused();
	await input.fill("keyboard.md");
	await input.press("Enter");
	await expect(page.getByText("keyboard.md", { exact: true })).toBeVisible();
	await checkbox(page, "keyboard.md").click();
	await item(page, "keyboard.md").focus();
	await page.keyboard.press("Delete");
	await expect(page.getByRole("dialog")).toContainText("Delete 1 item");
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Cancel" })
		.click();
	expect(
		await page.evaluate(() =>
			window.directoryQA.files.some((file) => file.path === "/keyboard.md"),
		),
	).toBe(true);
});

test("selection respects the hidden-files preference", async ({ page }) => {
	await expect(page.getByText(".secret.md", { exact: true })).toHaveCount(0);
	await expect(page.getByText(".cache", { exact: true })).toHaveCount(0);
	await page.goto("/?hidden");
	await expect(page.getByText(".secret.md", { exact: true })).toBeVisible();
	await expect(page.getByText(".cache", { exact: true })).toBeVisible();
	await item(page, "alpha.md").focus();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(selected(page)).toHaveCount(7);
});

test("historical listings preserve immutable snapshot navigation", async ({
	page,
}) => {
	await page.goto("/?history");
	await expect(page.getByText("past.md", { exact: true })).toBeVisible();
	await expect(page.getByText("alpha.md", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "New", exact: true }),
	).toBeDisabled();
	await checkbox(page, "past.md").click();
	await selectionActions(page).getByRole("button", { name: /More/ }).click();
	await expect(
		page.getByRole("menuitem", { name: "Download", exact: true }),
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "Delete", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Clear selection" }).click();
	await item(page, "past.md").click();
	expect(
		await page.evaluate(() => window.directoryQA.opened.at(-1)?.path),
	).toBe("/past.md");
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) =>
				/^(INSERT|UPDATE|DELETE)/i.test(call.sql),
			),
		),
	).toHaveLength(0);
});

test("the README preview keeps the rows' own inset", async ({ page }) => {
	await page.goto("/?readme");
	await page.waitForSelector("[data-testid=home-readme]");
	// The document, the caption above it and the rows above that share one
	// column: the seam reads as the list's footer, not as a second margin.
	const columns = await page.evaluate(() => {
		const inset = (element: Element) => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return [
				Math.round(rect.left + Number.parseFloat(style.paddingLeft)),
				Math.round(rect.right - Number.parseFloat(style.paddingRight)),
			];
		};
		const row = document.querySelector("[data-path]")!;
		const icon = row.querySelector("img")!.getBoundingClientRect();
		return {
			row: inset(row),
			rowIcon: Math.round(icon.left),
			caption: Math.round(
				document
					.querySelector("[data-testid=home-readme-preview] img")!
					.getBoundingClientRect().left,
			),
			document: inset(document.querySelector("[data-testid=home-readme]")!),
		};
	});
	expect(columns.document).toEqual(columns.row);
	expect(columns.caption).toBe(columns.rowIcon);
	expect(columns.rowIcon).toBe(columns.row[0]);
});

test("working changes mark the listing without a review open", async ({
	page,
}) => {
	await page.goto("/");
	// The glyph replaces the row's meta, and a folder inherits one from the
	// change under it, so the listing says where to click in.
	// The glyph is the only labelled span in a row; the name carries a
	// plain title.
	const glyphTitle = (name: string) =>
		item(page, name).locator("span[aria-label]").first();
	await expect(glyphTitle("alpha.md")).toHaveAttribute("title", "Modified");
	await expect(glyphTitle("gamma.csv")).toHaveAttribute("title", "Added");
	await expect(glyphTitle("beta.md")).toHaveAttribute("title", "Moved");
	await expect(glyphTitle("docs")).toHaveAttribute("title", "Modified");
	await expect(item(page, "research")).toHaveText(/0 items/);
	// The glyphs are Atelier's own shapes at the listing's 12px.
	expect(
		await glyphTitle("alpha.md").locator("svg").getAttribute("width"),
	).toBe("12");
	expect(await glyphTitle("alpha.md").locator("path").getAttribute("d")).toBe(
		"M3.3 6.3c.9-1.5 1.8-1.5 2.7 0s1.8 1.5 2.7 0",
	);
	// Outside a review nothing recedes: this is the ordinary file list.
	for (const name of ["alpha.md", "research", "docs"]) {
		expect(
			await item(page, name).evaluate((row) => getComputedStyle(row).opacity),
		).toBe("1");
	}
});

test("an open review names the rows; the rest recede", async ({ page }) => {
	await page.goto("/?review");
	await expect(item(page, "alpha.md")).toHaveAttribute(
		"data-changed-entry",
		"true",
	);
	await expect(item(page, "docs")).toHaveAttribute(
		"data-changed-entry",
		"true",
	);
	// gamma.csv is a working change the review does not carry: the session
	// is the authority while it is open.
	await expect(item(page, "gamma.csv")).not.toHaveAttribute(
		"data-changed-entry",
		"true",
	);
	expect(
		await item(page, "gamma.csv").evaluate(
			(row) => getComputedStyle(row).opacity,
		),
	).not.toBe("1");
});

test("a review that names no file falls back to the working diff", async ({
	page,
}) => {
	await page.goto("/?review-empty");
	await expect(
		item(page, "alpha.md").locator("span[aria-label]").first(),
	).toHaveAttribute("title", "Modified");
	await expect(item(page, "docs")).toHaveAttribute(
		"data-changed-entry",
		"true",
	);
});

test("reviewed file actions preserve diff-aware navigation", async ({
	page,
}) => {
	await page.goto("/?review");
	await item(page, "alpha.md").click();
	expect(await page.evaluate(() => window.directoryQA.diffOpened)).toEqual([
		"/alpha.md",
	]);
	expect(await page.evaluate(() => window.directoryQA.opened)).toEqual([]);
	await item(page, "beta.md").click();
	expect(
		await page.evaluate(() => window.directoryQA.opened.at(-1)?.path),
	).toBe("/beta.md");
});

test("an open folder follows an external rename by directory identity", async ({
	page,
}) => {
	await item(page, "docs").click();
	await expect(page.getByTestId("current-directory")).toHaveText("/docs");
	await page.evaluate(() => {
		for (const entry of [
			...window.directoryQA.dirs,
			...window.directoryQA.files,
		]) {
			if (entry.path === "/docs" || entry.path.startsWith("/docs/"))
				entry.path = "/renamed" + entry.path.slice("/docs".length);
		}
		window.directoryQA.refresh();
	});
	await expect(page.getByTestId("current-directory")).toHaveText("/renamed");
	await expect(page.getByText("child.md", { exact: true })).toBeVisible();
});

test("deleting the open folder externally returns to its surviving parent", async ({
	page,
}) => {
	await item(page, "docs").click();
	await expect(page.getByTestId("current-directory")).toHaveText("/docs");
	await page.evaluate(() => {
		for (const entries of [window.directoryQA.dirs, window.directoryQA.files]) {
			for (let index = entries.length - 1; index >= 0; index--)
				if (
					entries[index].path === "/docs" ||
					entries[index].path.startsWith("/docs/")
				)
					entries.splice(index, 1);
		}
		window.directoryQA.refresh();
	});
	await expect(page.getByTestId("current-directory")).toHaveText("/");
	await expect(page.getByText("alpha.md", { exact: true })).toBeVisible();
});

test("the shifted new-folder shortcut focuses naming immediately", async ({
	page,
}) => {
	await item(page, "alpha.md").focus();
	await page.keyboard.press("ControlOrMeta+Shift+Period");
	await expect(
		page.getByRole("textbox", { name: "Folder name" }),
	).toBeFocused();
	expect(
		await page.evaluate(() =>
			window.directoryQA.calls.filter((call) => /^INSERT/i.test(call.sql)),
		),
	).toHaveLength(0);
});

test("inactive folder changes wait until activation before navigating", async ({
	page,
}) => {
	await item(page, "docs").click();
	await expect(page.getByTestId("current-directory")).toHaveText("/docs");
	await page.evaluate(() => window.directoryQA.setActive(false));
	await expect(page.getByRole("row")).toHaveCount(0);
	await page.evaluate(() => {
		for (const entry of [
			...window.directoryQA.dirs,
			...window.directoryQA.files,
		]) {
			if (entry.path === "/docs" || entry.path.startsWith("/docs/"))
				entry.path = "/renamed" + entry.path.slice("/docs".length);
		}
		window.directoryQA.refresh();
	});
	await expect(page.getByTestId("current-directory")).toHaveText("/docs");
	expect(await page.evaluate(() => window.directoryQA.opened)).toHaveLength(1);
	await page.evaluate(() => window.directoryQA.setActive(true));
	await expect(page.getByTestId("current-directory")).toHaveText("/renamed");
	await expect(page.getByText("child.md", { exact: true })).toBeVisible();
});

test("review indicators refresh when entering and leaving review", async ({
	page,
}) => {
	await page.goto("/?review");
	const alpha = item(page, "alpha.md");
	const beta = item(page, "beta.md");
	const gamma = item(page, "gamma.csv");
	await expect(alpha).toHaveAttribute("data-changed-entry", "true");
	await expect(beta).toHaveClass(/opacity-\[0\.35\]/);
	await expect(gamma).not.toHaveAttribute("data-changed-entry", "true");
	await page.getByRole("button", { name: "Toggle review" }).click();
	// Closing review restores the working diff, which still includes alpha
	// and also includes gamma, absent from this review.
	await expect(gamma).toHaveAttribute("data-changed-entry", "true");
	await expect(alpha).toHaveAttribute("data-changed-entry", "true");
	await expect(beta).not.toHaveClass(/opacity-\[0\.35\]/);
	await alpha.click();
	expect(await page.evaluate(() => window.directoryQA.diffOpened)).toEqual([]);
	await page.getByRole("button", { name: "Toggle review" }).click();
	await expect(alpha).toHaveAttribute("data-changed-entry", "true");
	await expect(beta).toHaveClass(/opacity-\[0\.35\]/);
	await expect(gamma).not.toHaveAttribute("data-changed-entry", "true");
});
