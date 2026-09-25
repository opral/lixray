import { compatibility } from "@lix-js/sdk/compatibility";
import { expect, test } from "@playwright/test";

test("Account tokens have generated names, creation dates and independent deletion", async ({
	browser,
	page,
	context,
	request,
	baseURL,
}) => {
	test.skip(
		!baseURL || !["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname),
		"uses the local development account only",
	);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/sign-in?returnTo=/home");
	await page
		.getByRole("button", { name: "Continue as local developer" })
		.click();
	await page.waitForURL("**/home");
	await expect(
		page.getByRole("button", { name: "Account menu" }),
	).toBeVisible();

	const { namespace, namespaceId, accessToken } = await page.evaluate(
		async () => {
			const moduleUrl = "/src/lib/supabase.ts";
			const { getBrowserSupabaseClient } = (await import(
				/* @vite-ignore */ moduleUrl
			)) as typeof import("../../src/lib/supabase");
			const client = getBrowserSupabaseClient();
			const { data, error } = await client.rpc("bootstrap_personal_namespace");
			if (error || !data?.[0])
				throw new Error("Local account bootstrap failed");
			const {
				data: { session },
			} = await client.auth.getSession();
			if (!session) throw new Error("Local session required");
			return {
				namespace: data[0].namespace_handle,
				namespaceId: data[0].namespace_id,
				accessToken: session.access_token,
			};
		},
	);
	const runId = crypto.randomUUID();
	async function create(name: string) {
		const idempotencyKey = crypto.randomUUID();
		const response = await request.post(`${baseURL}/lix/v1`, {
			maxRetries: 2,
			headers: {
				authorization: `Bearer ${accessToken}`,
				"idempotency-key": idempotencyKey,
				"x-lixray-namespace-id": namespaceId,
				"x-lixray-repository-name": encodeURIComponent(name),
			},
		});
		if (!response.ok())
			throw new Error(
				`Test repository creation failed: ${response.status()} ${await response.text()}`,
			);
		return ((await response.json()) as { id: string }).id;
	}
	const lixId = await create(`API token test ${runId}`);
	const otherId = await create(`Other API token test ${runId}`);
	const createdIds = [lixId, otherId];
	try {
		await page.goto(`/settings/@${namespace}`);
		// The first repository opens a cold Vite module graph, WASM engine, and
		// synced storage. Keep this startup budget separate from token actions.
		await expect(
			page.getByRole("region", { name: "API tokens", exact: true }),
		).toBeVisible({
			timeout: 30_000,
		});
		await expect(
			page.getByRole("heading", { name: "API tokens", exact: true }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Generate token", exact: true })
			.click();
		const secret = page.getByLabel("New API token", { exact: true });
		await expect(secret).toBeVisible();
		const first = await secret.inputValue();
		const panel = page.getByRole("region", { name: "API tokens", exact: true });
		const firstName = await panel
			.getByRole("listitem")
			.first()
			.getAttribute("aria-label");
		expect(firstName).toMatch(/^[a-z]+-[a-z]+(-[0-9]+)?$/);
		await expect(panel.getByRole("listitem").first()).toContainText("Created");
		expect(
			await panel
				.getByRole("listitem")
				.first()
				.locator("time")
				.first()
				.getAttribute("datetime"),
		).toBeTruthy();
		expect(first).toMatch(/^lixray_pat_[0-9a-f]{64}$/);
		const openWithToken = (repositoryId: string) =>
			request.get(`/lix/v1/${repositoryId}/`, {
				headers: {
					Authorization: `Bearer ${first}`,
					"Lix-Server-Protocol-Version": String(
						compatibility.serverProtocolVersion,
					),
				},
			});
		// Each freshly created Lix is lazy on the server. Establish the SDK
		// target's first authenticated handshake before exercising openLix().
		const targetRepo = await openWithToken(lixId);
		expect(targetRepo.status()).toBe(200);
		const otherRepo = await openWithToken(otherId);
		expect(otherRepo.status()).toBe(200);
		await page.getByRole("button", { name: "Copy token", exact: true }).click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			first,
		);
		await page.getByRole("button", { name: "Done", exact: true }).click();
		await expect(secret).toHaveCount(0);
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Generate token", exact: true }),
		).toBeEnabled();
		await expect(secret).toHaveCount(0);

		// Vite may reload the page while discovering these browser-only SDK
		// modules. Let that happen before the stateful SDK assertions below.
		await expect
			.poll(
				async () => {
					try {
						await page.evaluate(async () => {
							await import(
								/* @vite-ignore */ "/node_modules/@lix-js/sdk/dist/index.js"
							);
							await import(
								/* @vite-ignore */ "/node_modules/@lix-js/storage-opfs/dist/index.js"
							);
						});
						return true;
					} catch (error) {
						if (
							/Execution context was destroyed|Failed to fetch/.test(
								String(error),
							)
						)
							return false;
						throw error;
					}
				},
				{ timeout: 30_000 },
			)
			.toBe(true);

		// Exercise both SDK modes against the real local gateway and Lix server.
		const paths = await page.evaluate(
			async ({ token, lixId }) => {
				const sdkUrl = "/node_modules/@lix-js/sdk/dist/index.js";
				const { openLix } = (await import(
					/* @vite-ignore */ sdkUrl
				)) as typeof import("@lix-js/sdk");
				const connection = {
					url: `${window.location.origin}/lix/${lixId}`,
					headers: { Authorization: `Bearer ${token}` },
				};
				const remote = await openLix({
					server: connection,
				});
				try {
					await remote.execute(
						"INSERT INTO lix_file (path, content) VALUES ($1, $2)",
						["/api-token.txt", new TextEncoder().encode("API token works")],
					);
					const snapshot = new Uint8Array(
						await new Response(remote.exportSnapshot()).arrayBuffer(),
					);
					if (new TextDecoder().decode(snapshot.subarray(0, 7)) !== "LIXSNAP") {
						throw new Error("Authenticated remote snapshot export was invalid");
					}
				} finally {
					await remote.close();
				}
				const storageUrl = "/node_modules/@lix-js/storage-opfs/dist/index.js";
				const { OpfsStorage } = (await import(
					/* @vite-ignore */ storageUrl
				)) as typeof import("@lix-js/storage-opfs");
				const sync = await openLix({
					storage: new OpfsStorage({ name: `api-token-test-${lixId}` }),
					server: { ...connection, mode: "partial_replica" },
				});
				try {
					return (
						await sync.execute(
							"SELECT path FROM lix_file WHERE path = '/api-token.txt'",
						)
					).rows;
				} finally {
					await sync.close();
				}
			},
			{ token: first, lixId },
		);
		expect(paths).toEqual([{ path: "/api-token.txt" }]);

		// Desktop uploads a snapshot body. Buffer this tiny browser fixture because
		// Chromium streaming requests require HTTP/2 and the local server uses HTTP/1.
		const snapshot = await page.evaluate(async () => {
			const sdkUrl = "/node_modules/@lix-js/sdk/dist/index.js";
			const { openLix } = (await import(
				/* @vite-ignore */ sdkUrl
			)) as typeof import("@lix-js/sdk");
			const local = await openLix();
			try {
				await local.execute(
					"INSERT INTO lix_file (path,content) VALUES ($1,$2)",
					["/shared.txt", new TextEncoder().encode("before")],
				);
				await local.execute("UPDATE lix_file SET content=$1 WHERE path=$2", [
					new TextEncoder().encode("after"),
					"/shared.txt",
				]);
				await local.execute(
					"INSERT INTO lix_file (path,content) VALUES ($1,$2)",
					["/private.txt", new TextEncoder().encode("private")],
				);
				await local.execute(
					"INSERT INTO lix_file (path,content) VALUES ($1,$2)",
					[
						"/public.md",
						new TextEncoder().encode(
							"# Published markdown through Atelier\n\nThis is the public document.",
						),
					],
				);
				return {
					bytes: Array.from(
						new Uint8Array(
							await new Response(local.exportSnapshot()).arrayBuffer(),
						),
					),
				};
			} finally {
				await local.close();
			}
		});
		const creation = await request.post("/lix/v1", {
			headers: {
				Authorization: `Bearer ${first}`,
				"Idempotency-Key": crypto.randomUUID(),
				"Content-Type": "application/vnd.lix.snapshot",
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
			},
			data: Buffer.from(snapshot.bytes),
		});
		expect(creation.status(), await creation.text()).toBe(201);
		const remote = (await creation.json()) as {
			id: ReturnType<typeof crypto.randomUUID>;
			url: string;
		};
		createdIds.push(remote.id);
		const importedState = await page.evaluate(
			async ({ token, url }) => {
				const sdkUrl = "/node_modules/@lix-js/sdk/dist/index.js";
				const { openLix } = (await import(
					/* @vite-ignore */ sdkUrl
				)) as typeof import("@lix-js/sdk");
				const hosted = await openLix({
					server: { url, headers: { Authorization: `Bearer ${token}` } },
				});
				try {
					return {
						files: (
							await hosted.execute(
								"SELECT path FROM lix_file WHERE path IN ('/.lix/plugins/plugin_markdown.lixplugin', '/private.txt', '/public.md', '/shared.txt') ORDER BY path",
							)
						).rows,
						workingFiles: (
							await hosted.execute(
								"SELECT to_path FROM lix_diff('lix_file') WHERE to_path IN ('/.lix/plugins/plugin_markdown.lixplugin', '/private.txt', '/public.md', '/shared.txt') ORDER BY to_path",
							)
						).rows,
					};
				} finally {
					await hosted.close();
				}
			},
			{ token: first, url: remote.url },
		);
		// Hosting checkpoints only its plugin; imported files remain working changes.
		expect(importedState).toEqual({
			files: [
				{ path: "/.lix/plugins/plugin_markdown.lixplugin" },
				{ path: "/private.txt" },
				{ path: "/public.md" },
				{ path: "/shared.txt" },
			],
			workingFiles: [
				{ to_path: "/private.txt" },
				{ to_path: "/public.md" },
				{ to_path: "/shared.txt" },
			],
		});
		const publication = await request.post(
			`/api/repositories/${remote.id}/share?path=/shared.txt`,
			{ headers: { Authorization: `Bearer ${first}` } },
		);
		expect(publication.status(), await publication.text()).toBe(200);
		expect(
			((await publication.json()) as { published: boolean }).published,
		).toBe(true);
		const privateFile = await request.get(
			`/lix/v1/${remote.id}/file?path=/private.txt`,
			{
				headers: {
					"Lix-Server-Protocol-Version": String(
						compatibility.serverProtocolVersion,
					),
				},
			},
		);
		expect([401, 403, 404]).toContain(privateFile.status());
		// Real anonymous browser + pinned SDK/server: protocol mocks cannot
		// hide a missing version header or a broken authorized download.
		const markdownPublication = await request.post(
			`/api/repositories/${remote.id}/share?path=/public.md`,
			{
				headers: { Authorization: `Bearer ${first}` },
			},
		);
		expect(markdownPublication.status()).toBe(200);
		const { url: publicUrl } = (await markdownPublication.json()) as {
			url: string;
		};
		const anonymous = await browser.newContext({ baseURL });
		try {
			const reader = await anonymous.newPage();
			const resolved = reader.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/published/entity",
				{ timeout: 30_000 },
			);
			const downloaded = reader.waitForResponse(
				(response) =>
					new URL(response.url()).pathname ===
					`/api/published/lix/${remote.id}/file`,
				{ timeout: 30_000 },
			);
			void downloaded.catch(() => undefined);
			await reader.goto(publicUrl);
			expect((await resolved).status()).toBe(200);
			const downloadUrl = (await downloaded).url();
			await expect(
				reader.getByRole("heading", {
					name: "Published markdown through Atelier",
					exact: true,
				}),
			).toBeVisible({ timeout: 60_000 });
			await expect(reader.locator(".atelier-file-view")).toHaveAttribute(
				"data-read-only",
				"true",
			);
			const unpublish = await request.delete(
				`/api/repositories/${remote.id}/share?path=/public.md`,
				{
					headers: { Authorization: `Bearer ${first}` },
				},
			);
			expect(unpublish.status()).toBe(200);
			const denied = await anonymous.request.get(downloadUrl);
			expect(denied.status()).toBe(404);
		} finally {
			await anonymous.close();
		}

		await panel
			.getByRole("button", { name: "Generate token", exact: true })
			.click();
		await expect(secret).toBeVisible();
		const second = await secret.inputValue();
		const secondName = await panel
			.getByRole("listitem")
			.first()
			.getAttribute("aria-label");
		expect(secondName).not.toBe(firstName);
		expect(second).not.toBe(first);
		await page.getByRole("button", { name: "Done", exact: true }).click();
		await expect(panel.getByRole("listitem")).toHaveCount(2);
		await page.reload();
		// Reload reopens the repository and its synced storage before mounting
		// Settings. Use the startup budget, then the usual token-action budget.
		await expect(
			page.getByRole("region", { name: "API tokens", exact: true }),
		).toBeVisible({
			timeout: 30_000,
		});
		await expect(panel.getByRole("listitem")).toHaveCount(2);
		await expect(secret).toHaveCount(0);
		for (const token of [first, second]) {
			const response = await request.get(`/lix/v1/${lixId}/`, {
				headers: {
					Authorization: `Bearer ${token}`,
					"Lix-Server-Protocol-Version": String(
						compatibility.serverProtocolVersion,
					),
				},
			});
			expect(response.status()).toBe(200);
		}
		await panel
			.getByRole("button", { name: `Delete ${firstName}`, exact: true })
			.click();
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Cancel", exact: true })
			.click();
		await expect(panel.getByRole("listitem")).toHaveCount(2);
		await panel
			.getByRole("button", { name: `Delete ${firstName}`, exact: true })
			.click();
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Delete token", exact: true })
			.click();
		await expect(panel.getByRole("listitem")).toHaveCount(1);
		const deletedResponse = await request.get(`/lix/v1/${lixId}/`, {
			headers: {
				Authorization: `Bearer ${first}`,
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
			},
		});
		expect(deletedResponse.status()).toBe(401);
		const remainingResponse = await request.get(`/lix/v1/${lixId}/`, {
			headers: {
				Authorization: `Bearer ${second}`,
				"Lix-Server-Protocol-Version": String(
					compatibility.serverProtocolVersion,
				),
			},
		});
		expect(remainingResponse.status()).toBe(200);
		await panel
			.getByRole("button", { name: `Delete ${secondName}`, exact: true })
			.click();
		await page
			.getByRole("dialog")
			.getByRole("button", { name: "Delete token", exact: true })
			.click();
		await expect(panel.getByRole("listitem")).toHaveCount(0);

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(
			page.getByRole("button", { name: "Generate token", exact: true }),
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
	} finally {
		await page.evaluate(async (ids) => {
			const moduleUrl = "/src/lib/supabase.ts";
			const { getBrowserSupabaseClient } = (await import(
				/* @vite-ignore */ moduleUrl
			)) as typeof import("../../src/lib/supabase");
			const client = getBrowserSupabaseClient();
			const { data: tokens } = await client.rpc("list_api_tokens");
			for (const token of tokens ?? [])
				await client.rpc("delete_api_token", { p_token_id: token.id });
			const {
				data: { session },
			} = await client.auth.getSession();
			for (const id of ids) {
				const response = await fetch(`/lix/v1/${id}`, {
					method: "DELETE",
					headers: { authorization: `Bearer ${session?.access_token}` },
				});
				if (!response.ok)
					throw new Error(`Test repository cleanup failed: ${response.status}`);
			}
		}, createdIds);
	}
});
