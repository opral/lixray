import { randomUUID } from "node:crypto";
import {
	LixService,
	type LixRuntimeClient,
	type WireValue,
} from "../../src/mcp/lix-service";
import { expect, test, type Request } from "@playwright/test";

// Match protocol paths, not Vite /@fs/.../vendor/lix/... module assets.
const protocolRequests = (url: URL) => url.pathname.startsWith("/lix/");

// Runs in the default Compose suite against the seeded development account and
// the actual browser SDK/OPFS implementation, with no external preview flags.
test("file and directory links survive offline moves, renames, checkpoints, and reload", async ({
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
		const response = await fetch("/lix/v1", {
			method: "POST",
			headers: {
				authorization: `Bearer ${signedIn.data.session.access_token}`,
				"idempotency-key": crypto.randomUUID(),
				"x-lixray-namespace-id": namespace.namespace_id,
				"x-lixray-repository-name": encodeURIComponent(slug),
			},
		});
		if (!response.ok)
			throw new Error(
				`Repository creation failed: ${response.status} ${await response.text()}`,
			);
		const { id } = (await response.json()) as { id: string };
		const metadata = await client
			.from("lixes")
			.select("slug")
			.eq("id", id)
			.single();
		if (metadata.error) throw metadata.error;
		return {
			id,
			name: slug,
			slug: metadata.data.slug,
			namespace: {
				id: namespace.namespace_id,
				name: namespace.namespace_name,
				handle: namespace.namespace_handle,
			},
			path: `/@${namespace.namespace_handle}/${metadata.data.slug}`,
			token: signedIn.data.session.access_token,
		};
	}, prefix);
	const endpoint = new URL(`/lix/v1/${repository.id}/`, baseURL);
	const headers = {
		Authorization: `Bearer ${repository.token}`,
		"Lix-Server-Protocol-Version": "7",
	};
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
			columns: Array<{ name: string }>;
			rows: Array<Array<{ kind: string; value: unknown }>>;
			rowsAffected: number;
			notices?: unknown[];
		};
	}
	const source = `${prefix}-source`;
	const target = `${prefix}-target`;
	const renamedSource = `${prefix}-renamed`;
	const finalPath = `/${target}/${renamedSource}/note.txt`;
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
		const directories = await execute(
			"INSERT INTO lix_directory (path) VALUES ($1), ($2) RETURNING id",
			[`/${source}`, `/${target}`],
		);
		const files = await execute(
			"INSERT INTO lix_file (path) VALUES ($1) RETURNING id",
			[`/${source}/note.txt`],
		);
		const directoryId = String(directories.rows[0]![0]!.value);
		const fileId = String(files.rows[0]![0]!.value);
		// Encode independently from application helpers so this asserts the public
		// URL contract as well as continuity through the real browser/OPFS path.
		const compactId = (id: string) =>
			Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url");
		// Exercise the actual MCP service over the authenticated protocol session.
		// The adapter keeps this regression independent of OAuth browser consent;
		// principal/context validation remains covered by MCP transport tests.
		const branch = await execute("SELECT lix_active_branch_id()");
		const branchId = String(branch.rows[0]![0]!.value);
		const runtime = {
			listLixes: async () => [repository],
			activeBranchId: async (lixId: string) => {
				expect(lixId).toBe(repository.id);
				return branchId;
			},
			execute: async (
				lixId: string,
				selectedBranch: string,
				request: { sql: string; params?: WireValue[] },
			) => {
				expect(lixId).toBe(repository.id);
				expect(selectedBranch).toBe(branchId);
				const result = await execute(
					request.sql,
					(request.params ?? []).map((value) => {
						if (value.kind !== "text")
							throw new Error(
								"URL lookup unexpectedly used a non-text parameter",
							);
						return value.value;
					}),
				);
				return {
					...result,
					rows: result.rows as WireValue[][],
					columns: result.columns.map((column) => column.name),
					notices: result.notices ?? [],
				};
			},
		} as unknown as LixRuntimeClient;
		const service = new LixService(runtime);
		const openedContext = await service.openLix(
			repository.id,
			undefined,
			baseURL,
		);
		const links = await service.getEntityUrls(
			openedContext.context,
			[
				{ kind: "directory", path: `/${source}` },
				{ kind: "file", id: fileId },
				{ kind: "directory", path: "/" },
			],
			baseURL,
		);
		const savedDirectoryUrl = links.entities[0]!.url;
		const savedFileUrl = links.entities[1]!.url;
		expect(links.entities[0]!.id).toBe(directoryId);
		expect(links.entities[1]!.id).toBe(fileId);
		expect(links.entities[2]!.url).toBe(openedContext.url);
		expect(openedContext.files.find((file) => file.id === fileId)?.url).toBe(
			savedFileUrl,
		);
		// A link carries the entity's own path: its folder and its name.
		expect(new URL(savedDirectoryUrl).pathname).toBe(
			`${repository.path}/folder/${compactId(directoryId)}/${source}`,
		);
		expect(new URL(savedFileUrl).pathname).toBe(
			`${repository.path}/file/${compactId(fileId)}/${source}/note.txt`,
		);
		for (const entity of links.entities) {
			expect(new URL(entity.url).origin).toBe(new URL(baseURL).origin);
			expect(new URL(entity.url).searchParams.get("branch")).toBe(branchId);
		}
		await page.goto(repository.path);
		// A cold browser worker compiles the SDK and downloads its initial replica.
		// Match the startup budget used by the other repository-opening tests.
		await expect(row(source)).toBeVisible({ timeout: 30_000 });
		await expect(row(target)).toBeVisible();
		context.on("request", captureCheckpoint);
		// Keep navigation/assets reachable so reload tests the persisted replica,
		// while every protocol operation from browser workers is unavailable.
		await context.route(protocolRequests, (route) => route.abort("aborted"));
		await row(source).dragTo(row(target));
		await expect(row(source)).toHaveCount(0, { timeout: 5_000 });
		await row(target).click();
		await expect(row(source)).toBeVisible();
		await row(source).hover();
		await row(source).locator("label").click();
		await row(source).focus();
		await page.keyboard.press("F2");
		const renameInput = page.getByRole("dialog").getByRole("textbox");
		await renameInput.fill(renamedSource);
		await renameInput.press("Enter");
		await expect(row(renamedSource)).toBeVisible();
		// These links still contain the original location's name. Neither moving
		// nor renaming the directory may invalidate it or its descendant file,
		// and each URL is rewritten to where the entity lives now.
		await page.goto(savedDirectoryUrl);
		await expect(row("note.txt")).toBeVisible({ timeout: 30_000 });
		await expect(page).toHaveURL(
			new RegExp(
				`/folder/${compactId(directoryId)}/${target}/${renamedSource}(?:\\?.*)?$`,
			),
		);
		await page.goto(savedFileUrl);
		await expect(
			page.locator('[data-view-key="atelier_text"][data-active="true"]'),
		).toBeVisible({ timeout: 30_000 });
		// The file moved with its folder: the URL says where it lives now.
		await expect(page).toHaveURL(
			new RegExp(
				`/file/${compactId(fileId)}/${target}/${renamedSource}/note\\.txt(?:\\?.*)?$`,
			),
		);
		await page
			.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
			})
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
				name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
			}),
		).toHaveCount(0);
		await page.reload();
		// Request interception disables HTTP caching. CI must reload Vite's
		// module graph and WASM before the persisted local replica can open.
		// Wait for the restored file route before navigating Home; the route
		// command must not race the folder listing we inspect next.
		await expect(
			page.locator('[data-view-key="atelier_text"][data-active="true"]'),
		).toBeVisible({ timeout: 30_000 });
		await page.getByRole("button", { name: "Home", exact: true }).click();
		await expect(row(target)).toBeVisible({ timeout: 30_000 });
		await row(target).click();
		await expect(row(renamedSource)).toBeVisible();
		await row(renamedSource).click();
		await expect(row("note.txt")).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
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
						"SELECT path FROM lix_file WHERE id = $1",
						[fileId],
					);
					return result.rows[0]?.[0]?.value;
				},
				{ timeout: 30_000 },
			)
			.toBe(finalPath);
		const movedDirectory = await execute(
			"SELECT path FROM lix_directory WHERE id = $1",
			[directoryId],
		);
		expect(movedDirectory.rows[0]?.[0]?.value).toBe(
			`/${target}/${renamedSource}`,
		);
		const renamedLinks = await service.getEntityUrls(
			openedContext.context,
			[
				{ kind: "directory", id: directoryId },
				{ kind: "file", path: finalPath },
			],
			baseURL,
		);
		expect(renamedLinks.entities.map((entry) => entry.id)).toEqual([
			directoryId,
			fileId,
		]);
		expect(renamedLinks.entities[0]!.path).toBe(`/${target}/${renamedSource}`);
		await page.goto(renamedLinks.entities[0]!.url);
		await expect(row("note.txt")).toBeVisible({ timeout: 30_000 });
		await page.goto(renamedLinks.entities[1]!.url);
		await expect(
			page.locator('[data-view-key="atelier_text"][data-active="true"]'),
		).toBeVisible({ timeout: 30_000 });
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
		await page.goto("/home");
		const deleted = await context.request.delete(endpoint.toString(), {
			headers,
		});
		expect(deleted.status()).toBe(204);
	}
});
