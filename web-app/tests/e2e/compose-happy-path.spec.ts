import { execFileSync } from "node:child_process";
import type { Response } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ExecuteResponse } from "../../src/lib/lixray-api";
import { openWorkspaceLixSession } from "../../src/lib/workspace-lix-session";

test("local OAuth consent uses the seeded development account", async ({
	page,
}) => {
	await page.goto("/oauth/consent");
	await expect(
		page.getByText("The authorization request is missing its identifier."),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Continue with Google" }),
	).toHaveCount(0);
});

test("local browser path reaches Lix through Compose", async ({
	page,
	request,
}) => {
	test.setTimeout(180_000);

	await page.goto("/sign-in");
	const handshake = page.waitForResponse(
		(response) =>
			/^\/@[^/]+\/[^/]+\/lix\/v1\/$/.test(new URL(response.url()).pathname) &&
			response.request().method() === "GET",
		{ timeout: 55_000 },
	);
	await page
		.getByRole("button", { name: "Continue as local developer" })
		.click();
	await expect(page).toHaveURL(/\/@[^/]+\/[^/]+$/);
	const lixPath = new URL(page.url()).pathname;

	const handshakeResponse = await handshake;
	await expectOk(handshakeResponse);
	const handshakeBody = (await handshakeResponse.json()) as {
		protocolVersion?: unknown;
		activeBranchId?: unknown;
	};
	expect(handshakeBody.protocolVersion).toBe(1);
	expect(handshakeBody.activeBranchId).toEqual(expect.any(String));
	await expect(
		page.getByRole("button", { name: "Toggle left panel" }),
	).toBeVisible({ timeout: 55_000 });
	await expect(
		page.getByRole("heading", { name: "Welcome to your Lix workspace" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Connect an agent" }).click();
	const connectDialog = page.getByRole("dialog", { name: "Connect an agent" });
	await expect(connectDialog).toBeVisible();
	await expect(
		connectDialog.getByRole("button", { name: "Copy prompt" }),
	).toBeVisible();
	await expect(connectDialog).toContainText("Paste it into your AI chat");
	await expect(page.getByTestId("agent-connection-status")).toContainText(
		"Waiting for agent",
	);

	const localSupabase = localSupabaseEnvironment();
	const authResponse = await request.post(
		`${localSupabase.API_URL}/auth/v1/token?grant_type=password`,
		{
			headers: {
				apikey: localSupabase.PUBLISHABLE_KEY,
				"Content-Type": "application/json",
			},
			data: {
				email: "dev@lixray.local",
				password: "lixray-local-dev",
			},
		},
	);
	expect(authResponse.ok(), await authResponse.text()).toBe(true);
	const auth = (await authResponse.json()) as {
		access_token: string;
		user: { id: string };
	};
	const [namespace, workspaceSlug] = lixPath
		.split("/")
		.filter(Boolean)
		.map((segment) => segment.replace(/^@/, ""));
	const resolutionResponse = await request.post(
		`${localSupabase.API_URL}/rest/v1/rpc/resolve_public_lix_by_route`,
		{
			headers: {
				apikey: localSupabase.PUBLISHABLE_KEY,
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": "application/json",
			},
			data: {
				p_namespace_handle: namespace,
				p_lix_slug: workspaceSlug,
			},
		},
	);
	expect(resolutionResponse.ok(), await resolutionResponse.text()).toBe(true);
	const resolution = (await resolutionResponse.json()) as Array<{
		lix_id: string;
	}>;
	const lixId = resolution[0]?.lix_id;
	expect(lixId).toEqual(expect.any(String));

	const connectionResponse = await request.post(
		`${localSupabase.API_URL}/rest/v1/mcp_lix_connections`,
		{
			headers: {
				apikey: localSupabase.SECRET_KEY,
				Authorization: `Bearer ${localSupabase.SECRET_KEY}`,
				"Content-Type": "application/json",
			},
			data: {
				user_id: auth.user.id,
				lix_id: lixId,
				oauth_client_id: "playwright-regression",
				last_tool: "active_branch_id",
			},
		},
	);
	expect(connectionResponse.ok(), await connectionResponse.text()).toBe(true);
	await expect(page.getByTestId("agent-connection-status")).toContainText(
		"Agent connected",
		{ timeout: 5_000 },
	);

	const firstFilePath = `/agent-first-${Date.now()}.md`;
	const externalSession = await openWorkspaceLixSession({
		namespace,
		workspaceSlug,
		origin: new URL(page.url()).origin,
		getAccessToken: async () => auth.access_token,
	});
	try {
		await externalSession.lix.execute(
			"INSERT INTO lix_file (path, data) VALUES ($1, $2)",
			[firstFilePath, new TextEncoder().encode("# First agent file\n")],
		);
		await expect(page).toHaveURL(
			new RegExp(
				`${escapeRegExp(lixPath)}/file/${escapeRegExp(firstFilePath.slice(1))}$`,
			),
			{ timeout: 10_000 },
		);
		await expect(
			page.getByRole("heading", { name: "First agent file" }),
		).toBeVisible();
	} finally {
		await externalSession.lix.execute("DELETE FROM lix_file WHERE path = $1", [
			firstFilePath,
		]);
		await externalSession.close();
		await request.delete(
			`${localSupabase.API_URL}/rest/v1/mcp_lix_connections?oauth_client_id=eq.playwright-regression&lix_id=eq.${lixId}`,
			{
				headers: {
					apikey: localSupabase.SECRET_KEY,
					Authorization: `Bearer ${localSupabase.SECRET_KEY}`,
				},
			},
		);
	}

	await page.goto("/sql");
	await expect(
		page.getByRole("heading", { name: "SQL console" }),
	).toBeVisible();
	await expect(page.getByTestId("branch-button").first()).toBeVisible({
		timeout: 55_000,
	});

	await page.getByLabel("Statement").fill("SELECT 1 AS one");
	await page.getByLabel("Params").fill("[]");
	const execution = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === `${lixPath}/lix/v1/execute` &&
			response.request().method() === "POST",
		{ timeout: 55_000 },
	);
	await page.getByRole("button", { name: "Execute" }).click();
	const executionResponse = await execution;
	await expectOk(executionResponse);
	expect((await executionResponse.json()) as ExecuteResponse).toEqual({
		columns: ["one"],
		rows: [[{ kind: "int", value: 1 }]],
		rowsAffected: 0,
		notices: [],
	});
	await expect(page.getByTestId("result-table")).toContainText("1");
});

async function expectOk(response: Response) {
	const body = response.ok() ? "" : await response.text();
	expect(response.ok(), `${response.status()}: ${body.slice(0, 500)}`).toBe(
		true,
	);
}

function localSupabaseEnvironment(): {
	API_URL: string;
	PUBLISHABLE_KEY: string;
	SECRET_KEY: string;
} {
	const output = execFileSync(
		"pnpm",
		["--dir", "../database", "exec", "supabase", "status", "-o", "env"],
		{ cwd: process.cwd(), encoding: "utf8" },
	);
	const values = Object.fromEntries(
		output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.includes("="))
			.map((line) => {
				const separator = line.indexOf("=");
				return [
					line.slice(0, separator),
					line.slice(separator + 1).replace(/^['"]|['"]$/g, ""),
				];
			}),
	);
	if (!values.API_URL || !values.PUBLISHABLE_KEY || !values.SECRET_KEY) {
		throw new Error("Local Supabase environment is incomplete");
	}
	return values as {
		API_URL: string;
		PUBLISHABLE_KEY: string;
		SECRET_KEY: string;
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
