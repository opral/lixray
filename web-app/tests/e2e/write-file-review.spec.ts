import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Request } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "./fixtures";
import {
	DEMO_CREATED_WORKSPACE_ID,
	DEMO_MAIN_BRANCH_ID,
	DEMO_WORKSPACE_ID,
} from "../../src/lib/demo-identity";

const WORKSPACE_ROUTE = "/@acme/mcp-review";
const PREVIEW_HOST = "127.0.0.1";
const WEB_APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("an MCP-created file enters review mode only after the user opens it", async ({
	baseURL,
	page,
}) => {
	test.setTimeout(120_000);
	const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL ? baseURL : undefined;
	if (process.env.PLAYWRIGHT_BASE_URL && !externalBaseURL) {
		throw new Error(
			"PLAYWRIGHT_BASE_URL did not produce a Playwright base URL.",
		);
	}
	const preview = externalBaseURL
		? { baseURL: externalBaseURL, close: () => Promise.resolve() }
		: await startIsolatedPreview();
	const pendingExecutes = trackPageExecutes(page);
	const appBaseURL = preview.baseURL;
	const fileName = `mcp-created-review-${randomUUID()}.md`;
	const content = "# Created through MCP\n";
	let client: Client | undefined;
	try {
		await page.goto(new URL("/", appBaseURL).toString());
		await page.getByRole("button", { name: "New workspace" }).click();
		await page
			.getByRole("textbox", { name: "Workspace name" })
			.fill("MCP Review");
		await page.getByRole("button", { name: "Create workspace" }).click();
		await page.getByRole("link", { name: /MCP Review/ }).click();
		await expect(page).toHaveURL(
			new URL(WORKSPACE_ROUTE, appBaseURL).toString(),
		);
		await expect(
			page.getByRole("button", { name: "Toggle left panel" }),
		).toBeVisible({ timeout: 55_000 });
		await settlePageExecutes(page, pendingExecutes);

		client = new Client({ name: "lixray-e2e", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(
			new URL("/mcp", appBaseURL),
		);
		await client.connect(transport);
		const result = await client.callTool({
			name: "write_file",
			arguments: {
				workspace_id: DEMO_CREATED_WORKSPACE_ID,
				branch_id: DEMO_MAIN_BRANCH_ID,
				path: `/${fileName}`,
				content,
			},
		});
		expect(result.isError, JSON.stringify(result)).not.toBe(true);

		const workspaceURL = new URL(WORKSPACE_ROUTE, appBaseURL);
		workspaceURL.searchParams.set("branch", DEMO_MAIN_BRANCH_ID);
		await expect(page).toHaveURL(workspaceURL.toString(), { timeout: 30_000 });
		const createdFile = page.getByRole("treeitem", { name: fileName });
		await expect(createdFile).toBeVisible({ timeout: 30_000 });
		await createdFile.click();
		const fileURL = new URL(`${WORKSPACE_ROUTE}/file/${fileName}`, appBaseURL);
		fileURL.searchParams.set("branch", DEMO_MAIN_BRANCH_ID);
		await expect(page).toHaveURL(fileURL.toString(), { timeout: 30_000 });
		await expect(
			page.getByRole("heading", { name: "Created through MCP" }),
		).toBeVisible();
		const keepButton = page.getByRole("button", { name: /^Keep/ });
		await expect(keepButton).toBeVisible();
		for (
			let change = 0;
			change < 10 && (await keepButton.count());
			change += 1
		) {
			if (!(await keepButton.isEnabled())) {
				await expect(keepButton).toHaveCount(0, { timeout: 30_000 });
				break;
			}
			await keepButton.click();
		}
		await expect(keepButton).toHaveCount(0, { timeout: 30_000 });
		await settlePageExecutes(page, pendingExecutes);
		await expect(
			page.getByRole("heading", { name: "Created through MCP" }),
		).toBeVisible();
		const readBack = await client.callTool({
			name: "read_file",
			arguments: {
				workspace_id: DEMO_CREATED_WORKSPACE_ID,
				branch_id: DEMO_MAIN_BRANCH_ID,
				path: `/${fileName}`,
			},
		});
		expect(readBack.isError, JSON.stringify(readBack)).not.toBe(true);
		expect(readBack.structuredContent).toEqual(
			expect.objectContaining({ path: `/${fileName}`, content }),
		);
	} finally {
		try {
			if (!page.isClosed()) await page.goto("about:blank");
		} finally {
			try {
				await client?.close();
			} finally {
				await preview.close();
			}
		}
	}
});

async function startIsolatedPreview(): Promise<{
	baseURL: string;
	close: () => Promise<void>;
}> {
	const port = await availablePort();
	const statePath = await mkdtemp(join(tmpdir(), "lixray-mcp-review-e2e-"));
	const env = {
		...process.env,
		LIXRAY_WORKER_TARGET: "e2e",
		LIXRAY_DEMO: "1",
		LIXRAY_DEMO_WORKSPACE_IDS: `${DEMO_WORKSPACE_ID},${DEMO_CREATED_WORKSPACE_ID}`,
		VITE_LIXRAY_DEMO: "1",
	};
	delete env.FORCE_COLOR;
	const child = spawn(
		"pnpm",
		[
			"exec",
			"wrangler",
			"dev",
			"--config",
			"./wrangler.preview-runtime.jsonc",
			"--persist-to",
			statePath,
			"--ip",
			PREVIEW_HOST,
			"--port",
			String(port),
		],
		{
			cwd: WEB_APP_ROOT,
			detached: process.platform !== "win32",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	let spawnError: Error | undefined;
	const appendOutput = (chunk: Buffer) => {
		output = `${output}${chunk.toString()}`.slice(-12_000);
	};
	child.stdout.on("data", appendOutput);
	child.stderr.on("data", appendOutput);
	child.on("error", (cause) => {
		spawnError = cause;
	});
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		try {
			await stopChildProcess(child);
		} finally {
			await rm(statePath, { recursive: true, force: true });
		}
	};
	const baseURL = `http://${PREVIEW_HOST}:${port}`;
	try {
		await waitForPreviewHealth(child, baseURL, () => spawnError);
	} catch (cause) {
		await close();
		throw new Error(`Isolated preview failed to start.\n${output}`, { cause });
	}
	return { baseURL, close };
}

async function availablePort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, PREVIEW_HOST, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a preview port."));
				return;
			}
			server.close((cause) => {
				if (cause) reject(cause);
				else resolve(address.port);
			});
		});
	});
}

async function waitForPreviewHealth(
	child: ChildProcess,
	baseURL: string,
	getSpawnError: () => Error | undefined,
) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const spawnError = getSpawnError();
		if (spawnError) throw spawnError;
		if (child.exitCode !== null) {
			throw new Error(`Preview exited with code ${child.exitCode}.`);
		}
		try {
			const response = await fetch(new URL("/healthz", baseURL), {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return;
		} catch {
			// Wrangler is still starting.
		}
		await delay(200);
	}
	throw new Error("Timed out waiting for isolated preview health.");
}

async function stopChildProcess(child: ChildProcess) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null)
		return;
	signalChildProcess(child, "SIGTERM");
	await Promise.race([once(child, "exit"), delay(5_000)]);
	if (child.exitCode !== null || child.signalCode !== null) return;
	signalChildProcess(child, "SIGKILL");
	await once(child, "exit");
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
	}
}

function delay(milliseconds: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function trackPageExecutes(page: Page): Set<Request> {
	const requests = new Set<Request>();
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname.endsWith("/execute")
		) {
			requests.add(request);
		}
	});
	page.on("requestfinished", (request) => requests.delete(request));
	page.on("requestfailed", (request) => requests.delete(request));
	return requests;
}

async function settlePageExecutes(page: Page, requests: Set<Request>) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await expect.poll(() => requests.size).toBe(0);
}
