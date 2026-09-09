import { randomUUID } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";

// Match protocol paths, not Vite /@fs/.../vendor/lix/... module assets.
const protocolRequests = (url: URL) =>
	url.pathname.startsWith("/lix/") ||
	/^\/api\/repositories\/[^/]+\/provision$/.test(url.pathname);

// Runs in the default Compose suite against the seeded development account and
// the actual browser SDK/OPFS implementation, with no external preview flags.
test("folder moves and checkpoints commit offline, survive reload, and upload unchanged", async ({
	page,
	context,
	baseURL,
}) => {
	if (!baseURL) throw new Error("Playwright baseURL is required");
	const prefix = `offline-${randomUUID()}`;
	await page.goto("/sign-in?returnTo=/home");
	await page
		.getByRole("button", { name: "Continue as local developer" })
		.click();
	await page.waitForURL("**/home");
	await expect(
		page.getByRole("button", { name: "Account menu" }),
	).toBeVisible();
	const repository = await page.evaluate(async (slug) => {
		// Compose uses real Supabase authorization, unlike deployed demo previews.
		// Load the app's configured client so the browser and setup requests share
		// the same persisted development session and repository permissions.
		const moduleUrl = "/src/lib/supabase.ts";
		const { getBrowserSupabaseClient } = (await import(
			/* @vite-ignore */ moduleUrl
		)) as typeof import("../../src/lib/supabase");
		const client = getBrowserSupabaseClient();
		const signedIn = await client.auth.getSession();
		if (signedIn.error || !signedIn.data.session)
			throw signedIn.error ?? new Error("Development sign-in omitted session");
		const provisioned = await client.rpc("bootstrap_personal_namespace");
		if (provisioned.error) throw provisioned.error;
		const namespace = provisioned.data[0];
		if (!namespace)
			throw new Error("Development namespace was not provisioned");
		const id = crypto.randomUUID();
		const inserted = await client
			.from("lixes")
			.insert({ id, namespace_id: namespace.namespace_id, name: slug, slug });
		if (inserted.error) throw inserted.error;
		return {
			id,
			path: `/@${namespace.namespace_handle}/${slug}`,
			token: signedIn.data.session.access_token,
		};
	}, prefix);
	const endpoint = new URL(`/lix/v1/${repository.id}/`, baseURL);
	const headers = {
		Authorization: `Bearer ${repository.token}`,
		"Lix-Server-Protocol-Version": "7",
	};
	const provisioned = await context.request.post(
		new URL(`/api/repositories/${repository.id}/provision`, baseURL).toString(),
		{ headers },
	);
	expect(provisioned.ok(), await provisioned.text()).toBe(true);
	const opened = await context.request.get(endpoint.toString(), { headers });
	expect(opened.status(), await opened.text()).toBe(200);
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
		expect(response.status(), await response.text()).toBe(200);
		return (await response.json()) as {
			rows: Array<Array<{ kind: string; value: unknown }>>;
		};
	}
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
		await page.goto(repository.path);
		await expect(row(source)).toBeVisible();
		await expect(row(target)).toBeVisible();
		context.on("request", captureCheckpoint);
		// Keep navigation/assets reachable so reload tests the persisted replica,
		// while every protocol operation from browser workers is unavailable.
		await context.route(protocolRequests, (route) => route.abort("aborted"));
		await row(source).dragTo(row(target));
		await expect(row(source)).toHaveCount(0, { timeout: 5_000 });
		await row(target).click();
		await expect(row(source)).toBeVisible();
		await row(source).click();
		await expect(row("note.txt")).toBeVisible();
		await page
			.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
			})
			.click();
		await page
			.getByRole("complementary", { name: "Navigator", exact: true })
			.getByRole("button", { name: "Working changes", exact: true })
			.click();
		const checkpointButton = page.getByRole("button", {
			name: "Checkpoint",
			exact: true,
		});
		await checkpointButton.click();
		// The action changes its label to “Checkpointing…” while SQL is pending.
		// Wait for the entire action to disappear before destroying the page.
		await expect(
			page.getByRole("button", { name: /^(Checkpoint|Checkpointing…)$/ }),
		).toHaveCount(0, { timeout: 5_000 });
		await expect(
			page.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
			}),
		).toHaveCount(0);
		await page.reload();
		// Request interception disables HTTP caching. CI must reload Vite's
		// module graph and WASM before the persisted local replica can open.
		// Reload restores the file route. Navigate Home to inspect the moved tree.
		await page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(row(target)).toBeVisible({ timeout: 30_000 });
		await row(target).click();
		await expect(row(source)).toBeVisible();
		await row(source).click();
		await expect(row("note.txt")).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Open checkpoint history/,
			}),
		).toHaveCount(0);
		await context.unroute(protocolRequests);
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
						"SELECT id AS commit_id FROM lix_commit WHERE id = $1 AND is_checkpoint",
						[checkpointId],
					);
					return result.rows[0]?.[0]?.value;
				},
				{ timeout: 30_000 },
			)
			.toBe(checkpointId);
	} finally {
		context.off("request", captureCheckpoint);
		await context.unroute(protocolRequests);
		await context.request.delete(new URL("session", endpoint).toString(), {
			headers: { ...headers, "Lix-Session-Id": sessionId },
		});
	}
});
