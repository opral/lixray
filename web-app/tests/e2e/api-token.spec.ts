import { expect, test } from "@playwright/test";

test("Repository tokens have generated names, creation dates and independent deletion", async ({
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

	const { lixId, otherId, namespace, slug } = await page.evaluate(async () => {
		const moduleUrl = "/src/lib/supabase.ts";
		const { getBrowserSupabaseClient } = (await import(
			/* @vite-ignore */ moduleUrl
		)) as typeof import("../../src/lib/supabase");
		const client = getBrowserSupabaseClient();
		const { data, error } = await client.rpc("bootstrap_personal_namespace");
		if (error || !data?.[0]) throw new Error("Local account bootstrap failed");
		const id = crypto.randomUUID();
		const otherId = crypto.randomUUID();
		const result = await client.from("lixes").insert([
			{
				id,
				namespace_id: data[0].namespace_id,
				name: "API token test",
				slug: `api-token-${id}`,
			},
			{
				id: otherId,
				namespace_id: data[0].namespace_id,
				name: "Other API token test",
				slug: `api-token-${otherId}`,
			},
		]);
		if (result.error) throw new Error("Test repository creation failed");
		return {
			lixId: id,
			otherId,
			namespace: data[0].namespace_handle,
			slug: `api-token-${id}`,
		};
	});
	try {
		await page.goto(`/@${namespace}/${slug}/settings`);
		// The first repository opens a cold Vite module graph, WASM engine, and
		// synced storage. Keep this startup budget separate from token actions.
		await expect(page.getByTestId("repository-settings-view")).toBeVisible({
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
		const wrongRepo = await request.get(`/lix/v1/${otherId}/`, {
			headers: { Authorization: `Bearer ${first}` },
		});
		expect(wrongRepo.status()).toBe(403);
		const otherToken = await page.evaluate(async (id) => {
			const moduleUrl = "/src/lib/supabase.ts";
			const { getBrowserSupabaseClient } = (await import(
				/* @vite-ignore */ moduleUrl
			)) as typeof import("../../src/lib/supabase");
			const { data, error } = await getBrowserSupabaseClient().rpc(
				"generate_api_token",
				{ p_lix_id: id },
			);
			if (error || !data?.[0])
				throw new Error("Second repository token failed");
			return data[0].token;
		}, otherId);
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
					server: { ...connection, mode: "remote" },
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
					server: { ...connection, mode: "sync" },
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
		await expect(page.getByTestId("repository-settings-view")).toBeVisible({
			timeout: 30_000,
		});
		await expect(panel.getByRole("listitem")).toHaveCount(2);
		await expect(secret).toHaveCount(0);
		for (const token of [first, second]) {
			const response = await request.get(`/lix/v1/${lixId}/`, {
				headers: { Authorization: `Bearer ${token}` },
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
			headers: { Authorization: `Bearer ${first}` },
		});
		expect(deletedResponse.status()).toBe(401);
		const remainingResponse = await request.get(`/lix/v1/${lixId}/`, {
			headers: { Authorization: `Bearer ${second}` },
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

		const otherResponse = await request.get(`/lix/v1/${otherId}/`, {
			headers: { Authorization: `Bearer ${otherToken}` },
		});
		expect(otherResponse.status()).toBe(200);
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
		await page.evaluate(
			async (ids) => {
				const moduleUrl = "/src/lib/supabase.ts";
				const { getBrowserSupabaseClient } = (await import(
					/* @vite-ignore */ moduleUrl
				)) as typeof import("../../src/lib/supabase");
				const client = getBrowserSupabaseClient();
				for (const id of ids) {
					const { data: tokens } = await client.rpc("list_api_tokens", {
						p_lix_id: id,
					});
					for (const token of tokens ?? [])
						await client.rpc("delete_api_token", {
							p_lix_id: id,
							p_token_id: token.id,
						});
					await client.rpc("delete_lix", { p_lix_id: id });
				}
			},
			[lixId, otherId],
		);
	}
});
