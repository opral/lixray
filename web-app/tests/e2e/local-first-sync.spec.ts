import { randomUUID } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";

const repositoryId = "00000000-0000-4000-8000-000000000002";
const repositoryPath = "/@acme/launch-q3";

// Runs in the default Compose suite against the seeded demo authority and
// the actual browser SDK/OPFS implementation, with no external preview flags.
test("folder moves and checkpoints commit offline, survive reload, and upload unchanged", async ({
	page,
	context,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required");
	const endpoint = new URL(`/lix/v1/${repositoryId}/`, baseURL);
	const headers = { Authorization: "Bearer lixray-demo" };
	const opened = await context.request.get(endpoint.toString(), { headers });
	expect(opened.ok()).toBe(true);
	const { sessionId } = (await opened.json()) as { sessionId: string };
	let sequence = 0;
	async function execute(sql: string, values: string[] = []) {
		const response = await context.request.post(
			new URL("execute", endpoint).toString(),
			{
				headers: {
					...headers,
					"Lix-Session-Id": sessionId,
					"Idempotency-Key": `offline-compose-${prefix}-${sequence++}`,
				},
				data: { sql, params: values.map((value) => ({ kind: "text", value })) },
			},
		);
		expect(response.ok()).toBe(true);
		return (await response.json()) as {
			rows: Array<Array<{ kind: string; value: unknown }>>;
		};
	}
	const prefix = `offline-${randomUUID()}`;
	const source = `${prefix}-source`;
	const target = `${prefix}-target`;
	const finalPath = `/${target}/${source}/note.txt`;
	const checkpointIds = new Set<string>();
	const captureCheckpoint = (request: Request) => {
		if (request.method() !== "POST" || !request.url().endsWith("/sync/push"))
			return;
		const body = request.postDataJSON() as {
			refUpdates?: Array<{
				checkpointCommitId?: unknown;
				expectedCheckpointCommitId?: unknown;
			}>;
		};
		for (const update of body.refUpdates ?? []) {
			if (
				typeof update.checkpointCommitId === "string" &&
				update.checkpointCommitId !== update.expectedCheckpointCommitId
			)
				checkpointIds.add(update.checkpointCommitId);
		}
	};
	const grid = page.getByRole("grid", {
		name: "Files and folders",
		exact: true,
	});
	const row = (name: string) =>
		grid
			.getByRole("row")
			.filter({ has: page.getByText(name, { exact: true }) });
	try {
		await execute("INSERT INTO lix_directory (path) VALUES ($1), ($2)", [
			`/${source}`,
			`/${target}`,
		]);
		await execute("INSERT INTO lix_file (path) VALUES ($1)", [
			`/${source}/note.txt`,
		]);
		await page.goto(repositoryPath);
		await expect(row(source)).toBeVisible();
		await expect(row(target)).toBeVisible();
		context.on("request", captureCheckpoint);
		// Keep navigation/assets reachable so reload tests the persisted replica,
		// while every protocol operation from browser workers is unavailable.
		await context.route("**/lix/**", (route) => route.abort("aborted"));
		await row(source).dragTo(row(target));
		await expect(row(source)).toHaveCount(0, { timeout: 5_000 });
		await row(target).click();
		await expect(row(source)).toBeVisible();
		await row(source).click();
		await expect(row("note.txt")).toBeVisible();
		await page
			.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
			})
			.click();
		const checkpointButton = page.getByRole("button", {
			name: "Checkpoint",
			exact: true,
		});
		await checkpointButton.click();
		await expect(checkpointButton).toHaveCount(0, { timeout: 5_000 });
		await page.reload();
		await expect(row("note.txt")).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open changes review/,
			}),
		).toHaveCount(0);
		await context.unroute("**/lix/**");
		await expect.poll(() => checkpointIds.size, { timeout: 30_000 }).toBe(1);
		const [checkpointId] = checkpointIds;
		if (!checkpointId)
			throw new Error("checkpoint upload omitted local identity");
		await expect
			.poll(
				async () => {
					const result = await execute(
						"SELECT path FROM lix_file WHERE path = $1",
						[finalPath],
					);
					return result.rows[0]?.[0]?.value;
				},
				{ timeout: 30_000 },
			)
			.toBe(finalPath);
		await expect
			.poll(
				async () => {
					const result = await execute(
						"SELECT commit_id FROM lix_checkpoint WHERE commit_id = $1",
						[checkpointId],
					);
					return result.rows[0]?.[0]?.value;
				},
				{ timeout: 30_000 },
			)
			.toBe(checkpointId);
	} finally {
		context.off("request", captureCheckpoint);
		await context.unroute("**/lix/**");
		await context.request.delete(new URL("session", endpoint).toString(), {
			headers: { ...headers, "Lix-Session-Id": sessionId },
		});
	}
});
