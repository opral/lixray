import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { repositoryHead } from "../lib/page-head.ts";
import { encodeEntityId } from "../lib/entity-url.ts";

const id = "11111111-1111-4111-8111-111111111111";
const token = encodeEntityId(id);

void test("metadata uses cosmetic labels and useful token-only fallbacks", () => {
	for (const [view, label] of [
		["file", "File"],
		["folder", "Folder"],
	] as const) {
		const params = { namespace: "acme", repository: "repo", _splat: token };
		const head = repositoryHead(params, view);
		assert.equal(head.meta[0]?.title, `@acme/repo · ${label} — LixRay`);
		assert.equal(head.links[0]?.href, `/@acme/repo/${view}/${token}`);
		assert.equal(
			repositoryHead({ ...params, _splat: `${token}/hello-world.md` }, view)
				.meta[0]?.title,
			"@acme/repo · hello-world.md — LixRay",
		);
	}
});

void test("canonical metadata merges cosmetic aliases and preserves branch identity only", () => {
	const params = {
		namespace: "acme",
		repository: "repo",
		_splat: `${token}/stale-name.md`,
	};
	for (const view of ["file", "folder"] as const) {
		const expected = `/@acme/repo/${view}/${token}?branch=feature%2Fdocs`;
		assert.equal(
			repositoryHead(params, view, { branch: "feature/docs" }).links[0]?.href,
			expected,
		);
		assert.equal(
			repositoryHead({ ...params, _splat: token }, view, {
				branch: "feature/docs",
			}).links[0]?.href,
			expected,
		);
	}
	assert.equal(
		repositoryHead(params, undefined, { branch: "feature/docs" }).links[0]
			?.href,
		"/@acme/repo?branch=feature%2Fdocs",
	);
});

void test("SSR guidance resolves UUIDs with parameterized branch-context queries, never the slug", async () => {
	const directory = await mkdtemp(
		fileURLToPath(new URL("./.guidance-test-", import.meta.url)),
	);
	try {
		const built = await build({
			entryPoints: [
				fileURLToPath(
					new URL("../components/repository-mcp-guidance.tsx", import.meta.url),
				),
			],
			bundle: true,
			format: "esm",
			platform: "node",
			packages: "external",
			write: false,
		});
		const output = `${directory}/guidance.mjs`;
		await writeFile(output, built.outputFiles[0]!.text);
		const { RepositoryMcpGuidance } = (await import(
			pathToFileURL(output).href
		)) as {
			RepositoryMcpGuidance: ComponentType<{
				pathname: string;
				searchStr: string;
			}>;
		};
		for (const [verb, table] of [
			["file", "lix_file"],
			["folder", "lix_directory"],
			// Folder links written before /folder still resolve.
			["dir", "lix_directory"],
		]) {
			const html = renderToStaticMarkup(
				createElement(RepositoryMcpGuidance, {
					pathname: `/@acme/repo/${verb}/${token}/misleading-name.md`,
					searchStr: "?branch=branch-2",
				}),
			);
			assert.match(
				html,
				new RegExp(`SELECT id, path FROM ${table} WHERE id = \\$1`),
			);
			assert.ok(html.includes(id));
			assert.ok(html.includes("branch-2"));
			assert.ok(html.includes("structuredContent"));
			assert.ok(!html.includes("misleading-name.md"));
		}
		assert.equal(
			renderToStaticMarkup(
				createElement(RepositoryMcpGuidance, {
					pathname: "/@acme/repo/file/old-path.md",
					searchStr: "",
				}),
			),
			"",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
