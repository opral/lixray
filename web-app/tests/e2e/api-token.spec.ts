import { expect, test } from "@playwright/test";

test("Account tokens have generated names, creation dates and independent deletion", async ({
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

	const { lixId, otherId, namespace } = await page.evaluate(async () => {
		const moduleUrl = "/src/lib/supabase.ts";
		const { getBrowserSupabaseClient } = (await import(
			/* @vite-ignore */ moduleUrl
		)) as typeof import("../../src/lib/supabase");
		const client = getBrowserSupabaseClient();
		const { data, error } = await client.rpc("bootstrap_personal_namespace");
		if (error || !data?.[0]) throw new Error("Local account bootstrap failed");
		const {
			data: { session },
		} = await client.auth.getSession();
		if (!session) throw new Error("Local session required");
		async function create(name: string) {
			const response = await fetch("/lix/v1", {
				method: "POST",
				headers: {
					authorization: `Bearer ${session!.access_token}`,
					"idempotency-key": crypto.randomUUID(),
					"x-lixray-namespace-id": data![0]!.namespace_id,
					"x-lixray-repository-name": encodeURIComponent(name),
				},
			});
			if (!response.ok)
				throw new Error(
					`Test repository creation failed: ${response.status} ${await response.text()}`,
				);
			return ((await response.json()) as { id: string }).id;
		}
		return {
			lixId: await create("API token test"),
			otherId: await create("Other API token test"),
			namespace: data[0].namespace_handle,
		};
	});
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
		const otherRepo = await request.get(`/lix/v1/${otherId}/`, {
			headers: {
				Authorization: `Bearer ${first}`,
				"Lix-Server-Protocol-Version": "9",
			},
		});
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

		// Exercise both SDK modes against the real local gateway and Lix server.
		const paths = await page.evaluate(
			async ({ token, lixId }) => {
				const sdkUrl = "/node_modules/@lix-js/sdk/dist/index.js";
				const { openLix } = (await import(
					/* @vite-ignore */ sdkUrl
				)) as typeof import("@lix-js/sdk");
				const connection = {
					url: `${window.location.origin}/lix/${lixId}`,
					headers: async () => ({ Authorization: `Bearer ${token}` }),
				};
				const remote = await openLix({
					server: connection,
				});
				try {
					await remote.execute(
						"INSERT INTO lix_file (path, content) VALUES ($1, $2)",
						["/api-token.txt", new TextEncoder().encode("API token works")],
					);
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
				const history = (await local.execute("SELECT count(*) FROM lix_log()"))
					.rows;
				return {
					history,
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
				"Lix-Server-Protocol-Version": "9",
			},
			data: Buffer.from(snapshot.bytes),
		});
		expect(creation.status(), await creation.text()).toBe(201);
		const remote = (await creation.json()) as {
			id: ReturnType<typeof crypto.randomUUID>;
			url: string;
		};
		createdIds.push(remote.id);
		const importedHistory = await page.evaluate(
			async ({ token, url }) => {
				const sdkUrl = "/node_modules/@lix-js/sdk/dist/index.js";
				const { openLix } = (await import(
					/* @vite-ignore */ sdkUrl
				)) as typeof import("@lix-js/sdk");
				const hosted = await openLix({
					server: { url, headers: { Authorization: `Bearer ${token}` } },
				});
				try {
					return (await hosted.execute("SELECT count(*) FROM lix_log()")).rows;
				} finally {
					await hosted.close();
				}
			},
			{ token: first, url: remote.url },
		);
		expect(importedHistory).toEqual(snapshot.history);
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
			{ headers: { "Lix-Server-Protocol-Version": "9" } },
		);
		expect([401, 403, 404]).toContain(privateFile.status());

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
					"Lix-Server-Protocol-Version": "9",
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
				"Lix-Server-Protocol-Version": "9",
			},
		});
		expect(deletedResponse.status()).toBe(401);
		const remainingResponse = await request.get(`/lix/v1/${lixId}/`, {
			headers: {
				Authorization: `Bearer ${second}`,
				"Lix-Server-Protocol-Version": "9",
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
