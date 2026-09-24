import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Lix, openLix } from "@lix-js/sdk";
import {
	installMarkdownPlugin,
	MARKDOWN_PLUGIN_ASSET,
	MARKDOWN_PLUGIN_PATH,
} from "./markdown-plugin.ts";

const repositoryId = "11111111-1111-4111-8111-111111111111";
const account = { userId: "22222222-2222-4222-8222-222222222222" };
const env = {
	LIXRAY_LIX_SERVICE_URL: "http://server.test",
	LIXRAY_INTERNAL_TOKEN: "internal",
};

void test("shipped Markdown archive matches the pinned v0.1.0 release", async () => {
	const archive = await readFile(
		new URL("../../public/plugins/plugin_markdown.lixplugin", import.meta.url),
	);
	const checksum = await readFile(
		new URL("../../public/plugins/SHA256SUMS", import.meta.url),
		"utf8",
	);
	const sha256 = createHash("sha256").update(archive).digest("hex");
	assert.equal(
		sha256,
		"79a85893c42885599158f86f21b7ef76b822dfeb02214769e74994ea9fe048d6",
	);
	assert.equal(checksum, `${sha256}  plugin_markdown.lixplugin\n`);
});

void test("installs the shipped archive on the new host's active branch", async () => {
	const archive = new Uint8Array([1, 2, 3]);
	const calls: string[] = [];
	const lix = {
		execute: async (sql: string, params: unknown[]) => {
			if (sql.includes("INSERT INTO lix_file")) {
				calls.push("install");
				assert.match(sql, /ON CONFLICT \(path\) DO NOTHING/);
				assert.equal(params[0], MARKDOWN_PLUGIN_PATH);
				assert.deepEqual(params[1], archive);
				return { rowsAffected: 1 };
			}
			calls.push("checkpoint");
			assert.equal(sql, "SELECT commit_id FROM lix_create_checkpoint()");
		},
		close: async () => {
			calls.push("close");
		},
	} as unknown as Lix;
	await installMarkdownPlugin(
		new Request("https://lixray.test/lix/v1"),
		env,
		account,
		repositoryId,
		async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).pathname === MARKDOWN_PLUGIN_ASSET) {
				calls.push("download");
				return new Response(archive);
			}
			calls.push("protocol");
			assert.equal(new URL(request.url).host, "server.test");
			assert.equal(request.headers.get("authorization"), "Bearer internal");
			assert.equal(request.headers.get("x-lix-account-id"), account.userId);
			return new Response(null, { status: 204 });
		},
		(async (options) => {
			assert.equal(
				options.server?.url,
				`https://lixray.test/lix/${repositoryId}`,
			);
			await options.server?.fetch?.(
				new Request(`https://lixray.test/lix/v1/${repositoryId}/execute`, {
					method: "POST",
					headers: { "x-lixray-idempotency-principal": account.userId },
				}),
			);
			return lix;
		}) as typeof openLix,
	);
	assert.deepEqual(calls, ["download", "protocol", "install", "checkpoint", "close"]);
});

void test("unavailable static asset prevents opening a repository", async () => {
	await assert.rejects(
		installMarkdownPlugin(
			new Request("https://lixray.test/lix/v1"),
			env,
			account,
			repositoryId,
			async () => new Response(null, { status: 404 }),
			(async () => {
				throw new Error("must not open");
			}) as typeof openLix,
		),
		/Markdown plugin asset returned 404/,
	);
});
