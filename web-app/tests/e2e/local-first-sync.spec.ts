import {
	showLibraryFiles,
	libraryTab,
	libraryRow,
	libraryOpenButton,
} from "./library-fixture";
import { compatibility } from "@lix-js/sdk/compatibility";
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
	// The scenario waits for two real replicas and a server-backed checkpoint.
	test.setTimeout(300_000);
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
		"Lix-Server-Protocol-Version": String(compatibility.serverProtocolVersion),
	};
	const opened = await context.request.get(endpoint.toString(), { headers });
	expect(opened.status(), await opened.text()).toBe(200);
	const { sessionId } = (await opened.json()) as { sessionId: string };
	let sequence = 0;
	async function execute(
		sql: string,
		values: (string | Uint8Array)[] = [],
		timeout?: number,
	) {
		const response = await context.request.post(
			new URL("execute", endpoint).toString(),
			{
				timeout,
				headers: {
					...headers,
					"Lix-Session-Id": sessionId,
					"Idempotency-Key": `offline-compose-${prefix}-${sequence++}`,
				},
				data: {
					sql,
					params: values.map((value) =>
						typeof value === "string"
							? { kind: "text", value }
							: { kind: "blob", base64: Buffer.from(value).toString("base64") },
					),
				},
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
	const seededContent = `Offline move preserves ${prefix}.`;
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
	const row = (name: string) => libraryOpenButton(page, name);
	let primaryFailure = false;
	try {
		const directories = await execute(
			"INSERT INTO lix_directory (path) VALUES ($1), ($2) RETURNING id",
			[`/${source}`, `/${target}`],
		);
		const files = await execute(
			"INSERT INTO lix_file (path, content) VALUES ($1, $2) RETURNING id",
			[`/${source}/note.txt`, new TextEncoder().encode(seededContent)],
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
			// The repository opens on its default branch, which is what the
			// service compares against when deciding to name one in a URL.
			defaultBranchId: async (lixId: string) => {
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
		const displayDirectoryUrl = links.entities[0]!.display_url;
		const displayFileUrl = links.entities[1]!.display_url;
		expect(links.entities[0]!.id).toBe(directoryId);
		expect(links.entities[1]!.id).toBe(fileId);
		expect(links.entities[2]!.url).toBe(openedContext.url);
		expect(openedContext.files.find((file) => file.id === fileId)?.url).toBe(
			savedFileUrl,
		);
		expect(
			openedContext.files.find((file) => file.id === fileId)?.display_url,
		).toBe(displayFileUrl);
		// Stored links stop at the ID; display links include the current path.
		expect(new URL(savedDirectoryUrl).pathname).toBe(
			`${repository.path}/folder/${compactId(directoryId)}`,
		);
		expect(new URL(savedFileUrl).pathname).toBe(
			`${repository.path}/file/${compactId(fileId)}`,
		);
		expect(new URL(displayDirectoryUrl).pathname).toBe(
			`${repository.path}/folder/${compactId(directoryId)}/${source}`,
		);
		expect(new URL(displayFileUrl).pathname).toBe(
			`${repository.path}/file/${compactId(fileId)}/${source}/note.txt`,
		);
		for (const entity of links.entities) {
			expect(new URL(entity.url).origin).toBe(new URL(baseURL).origin);
			// On the default branch a URL says nothing about branches.
			expect(new URL(entity.url).searchParams.get("branch")).toBeNull();
		}
		// A sleeping authority may refuse the first read-only admission request.
		let admissionFailures = 1;
		let admissionRequests = 0;
		await page.route(`**/lix/v1/${repository.id}/admission`, async (route) => {
			admissionRequests += 1;
			if (admissionFailures > 0) {
				admissionFailures -= 1;
				await route.fulfill({ status: 502, body: "Bad Gateway" });
			} else {
				await route.continue();
			}
		});
		await page.goto(repository.path);
		await showLibraryFiles(page);
		// A cold browser worker compiles the SDK and downloads its initial replica.
		// Match the startup budget used by the other repository-opening tests.
		await expect(row(source)).toBeVisible({ timeout: 30_000 });
		await expect(row(target)).toBeVisible();
		await expect(libraryRow(page, source)).toHaveAttribute(
			"data-path",
			`/${source}`,
		);
		await expect(libraryRow(page, target)).toHaveAttribute(
			"data-path",
			`/${target}`,
		);
		expect(admissionRequests).toBe(2);
		// First use may hydrate native inputs. Read the actual file and open
		// working review online before asserting those workflows work offline.
		// Exhaust the bounded admission budget, then recover in place. The
		// previously downloaded local replica and seeded content must survive.
		const beforeRetry = admissionRequests;
		admissionFailures = 5;
		await page.goto(savedFileUrl);
		await expect(
			page.getByText("Unable to open Atelier", { exact: true }),
		).toBeVisible({ timeout: 30_000 });
		expect(admissionRequests - beforeRetry).toBe(5);
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		const textView = page.locator(
			'[data-view-key="atelier_text"][data-active="true"]',
		);
		await expect(textView).toBeVisible({ timeout: 30_000 });
		await expect(textView).toContainText(seededContent);
		expect(admissionRequests - beforeRetry).toBe(6);
		await page.unroute(`**/lix/v1/${repository.id}/admission`);
		await page
			.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Review working changes/,
			})
			.click();
		await expect(
			page.getByRole("button", { name: "Checkpoint", exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", {
				name: /[1-9]\d* files? changed since checkpoint\. Close review/,
			})
			.click();
		await expect(
			page.getByRole("button", { name: "Checkpoint", exact: true }),
		).toHaveCount(0);
		await page.goto(repository.path);
		await showLibraryFiles(page);
		await expect(row(source)).toBeVisible({ timeout: 30_000 });
		await expect(row(target)).toBeVisible();
		await expect(libraryRow(page, source)).toHaveAttribute(
			"data-path",
			`/${source}`,
		);
		await expect(libraryRow(page, target)).toHaveAttribute(
			"data-path",
			`/${target}`,
		);
		context.on("request", captureCheckpoint);
		// Keep navigation/assets reachable so reload tests the persisted replica,
		// while every protocol operation from browser workers is unavailable.
		await context.route(protocolRequests, (route) => route.abort("aborted"));
		await row(source).dragTo(row(target));
		await expect(row(source)).toHaveCount(0, { timeout: 5_000 });
		await row(target).click();
		await expect(row(source)).toBeVisible();
		await expect(libraryRow(page, source)).toHaveAttribute(
			"data-path",
			`/${target}/${source}`,
		);
		await row(source).hover();
		await libraryRow(page, source).getByRole("checkbox").click();
		await row(source).focus();
		await page.keyboard.press("F2");
		const renameInput = page.getByRole("dialog").getByRole("textbox");
		await renameInput.fill(renamedSource);
		await renameInput.press("Enter");
		await expect(row(renamedSource)).toBeVisible();
		await expect(libraryRow(page, renamedSource)).toHaveAttribute(
			"data-path",
			`/${target}/${renamedSource}`,
		);
		// Readable links retain the old path after a move, but resolve by ID and
		// rewrite to the current path. Stored links remain unchanged.
		await page.goto(displayDirectoryUrl);
		await expect(row("note.txt")).toBeVisible({ timeout: 30_000 });
		await expect(libraryRow(page, "note.txt")).toHaveAttribute(
			"data-path",
			finalPath,
		);
		await expect(page).toHaveURL(
			new RegExp(
				`/folder/${compactId(directoryId)}/${target}/${renamedSource}(?:\\?.*)?$`,
			),
		);
		await page.goto(displayFileUrl);
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
		await expect(checkpointButton).toBeVisible({ timeout: 10_000 });
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
		// Wait for the restored file route before navigating Library; the route
		// command must not race the folder listing we inspect next.
		await expect(
			page.locator('[data-view-key="atelier_text"][data-active="true"]'),
		).toBeVisible({ timeout: 30_000 });
		await libraryTab(page).click();
		// Library restores its saved folder; opening the workspace does not reset
		// tab state. The breadcrumb explicitly returns to the repository root.
		const folderPath = page.getByRole("navigation", { name: "Folder path" });
		await expect(folderPath).toContainText(target);
		await expect(
			page.getByRole("heading", { name: renamedSource, exact: true }),
		).toBeVisible();
		await expect(row("note.txt")).toBeVisible();
		await expect(libraryRow(page, "note.txt")).toHaveAttribute(
			"data-path",
			finalPath,
		);
		await folderPath
			.getByRole("button", { name: "Files", exact: true })
			.click();
		await expect(row(target)).toBeVisible({ timeout: 30_000 });
		await expect(libraryRow(page, target)).toHaveAttribute(
			"data-path",
			`/${target}`,
		);
		await row(target).click();
		await expect(row(renamedSource)).toBeVisible();
		await expect(libraryRow(page, renamedSource)).toHaveAttribute(
			"data-path",
			`/${target}/${renamedSource}`,
		);
		await row(renamedSource).click();
		await expect(row("note.txt")).toBeVisible();
		await expect(libraryRow(page, "note.txt")).toHaveAttribute(
			"data-path",
			finalPath,
		);
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
		expect(renamedLinks.entities[0]!.url).toBe(savedDirectoryUrl);
		expect(renamedLinks.entities[1]!.url).toBe(savedFileUrl);
		expect(new URL(renamedLinks.entities[0]!.display_url).pathname).toBe(
			`${repository.path}/folder/${compactId(directoryId)}/${target}/${renamedSource}`,
		);
		expect(new URL(renamedLinks.entities[1]!.display_url).pathname).toBe(
			`${repository.path}/file/${compactId(fileId)}/${target}/${renamedSource}/note.txt`,
		);
		await page.goto(renamedLinks.entities[0]!.url);
		await expect(row("note.txt")).toBeVisible({ timeout: 30_000 });
		await expect(libraryRow(page, "note.txt")).toHaveAttribute(
			"data-path",
			finalPath,
		);
		await page.goto(renamedLinks.entities[1]!.url);
		await expect(
			page.locator('[data-view-key="atelier_text"][data-active="true"]'),
		).toBeVisible({ timeout: 30_000 });
		await expect
			.poll(
				async () => {
					try {
						// A stalled authority read must not consume the entire poll budget.
						const result = await execute(
							"SELECT commit_id FROM lix_log() WHERE commit_id = $1 AND is_checkpoint",
							[checkpointId],
							20_000,
						);
						return result.rows[0]?.[0]?.value;
					} catch (error) {
						if (/Timeout.*exceeded|ECONNRESET/i.test(String(error)))
							return undefined;
						throw error;
					}
				},
				{ timeout: 90_000 },
			)
			.toBe(checkpointId);
	} catch (error) {
		primaryFailure = true;
		throw error;
	} finally {
		context.off("request", captureCheckpoint);
		await (async () => {
			await context.unroute(protocolRequests);
			await context.request.delete(new URL("session", endpoint).toString(), {
				headers: { ...headers, "Lix-Session-Id": sessionId },
			});
			await page.goto("/home");
			const deleted = await context.request.delete(endpoint.toString(), {
				headers,
			});
			expect(deleted.status()).toBe(204);
		})().catch((error: unknown) => {
			// Preserve the original failure if teardown finds a closed context.
			if (!primaryFailure) throw error;
		});
	}
});
