import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import {
	installBrowserArtifact,
	installServerImageArtifact,
} from "./lix-ci-artifacts.mjs";

const encoder = new TextEncoder();

test("installs an exact-revision artifact from a successful Lix CI run", async () => {
	const revision = "a".repeat(40);
	const archive = zipSync({
		"ci-artifact/browser.json": encoder.encode(
			JSON.stringify({ sourceRevision: revision }),
		),
		"packages/js-sdk/dist/index.js": encoder.encode("export const sdk = 1;"),
		"packages/js-sdk/dist/wasm/lix_js_sdk_bg.wasm": new Uint8Array([
			0, 97, 115, 109,
		]),
		"packages/storage-opfs/dist/index.js": encoder.encode(
			"export const opfs = 1;",
		),
	});
	const fixture = await artifactApiFixture({
		archive,
		revision,
		successful: true,
	});
	const destination = await mkdtemp(join(tmpdir(), "lix-artifact-test-"));
	const logs = [];
	try {
		process.env.LIX_CI_ARTIFACT_API_ROOT = fixture.url;
		const artifact = await installBrowserArtifact({
			log: (message) => logs.push(message),
			opfsStorageRoot: join(destination, "storage-opfs"),
			revision,
			sdkRoot: join(destination, "js-sdk"),
		});

		assert.equal(artifact.runId, 42);
		assert.equal(
			await readFile(join(destination, "js-sdk/dist/index.js"), "utf8"),
			"export const sdk = 1;",
		);
		assert.match(logs.join("\n"), /HIT lix-browser-sdk-/);
	} finally {
		delete process.env.LIX_CI_ARTIFACT_API_ROOT;
		await fixture.close();
		await rm(destination, { recursive: true, force: true });
	}
});

test("uses an artifact after its producer job uploads while the workflow continues", async () => {
	const revision = "b".repeat(40);
	const archive = zipSync({
		"server-linux-x64.json": encoder.encode(
			JSON.stringify({ sourceRevision: revision }),
		),
		"lix-server-image.tar": encoder.encode("image"),
	});
	const fixture = await artifactApiFixture({
		archive,
		revision,
		successful: false,
	});
	const destination = join(
		await mkdtemp(join(tmpdir(), "lix-artifact-test-")),
		"server.tar",
	);
	const logs = [];
	try {
		process.env.LIX_CI_ARTIFACT_API_ROOT = fixture.url;
		const artifact = await installServerImageArtifact({
			destination,
			log: (message) => logs.push(message),
			revision,
		});

		assert.equal(artifact.runId, 42);
		assert.match(logs.join("\n"), /in_progress\/artifact job complete/);
		assert.equal(await readFile(destination, "utf8"), "image");
	} finally {
		delete process.env.LIX_CI_ARTIFACT_API_ROOT;
		await fixture.close();
		await rm(dirname(destination), { recursive: true, force: true });
	}
});

test("a missing required artifact fails after one lookup with its producer link", async () => {
	const revision = "c".repeat(40);
	const fixture = await artifactApiFixture({ archive: new Uint8Array(), revision, missing: true });
	try {
		process.env.LIX_CI_ARTIFACT_API_ROOT = fixture.url;
		process.env.LIXRAY_LIX_ARTIFACTS = "only";
		await assert.rejects(installServerImageArtifact({ revision, destination: "unused", log() {} }), (error) => {
			assert.match(error.message, /Required Lix CI artifact .* is unavailable/);
			assert.ok(error.message.includes(`https://github.com/opral/lix/commit/${revision}/checks`));
			return true;
		});
		assert.equal(fixture.requests.length, 1);
		assert.match(fixture.requests[0], /actions\/artifacts\?/);
	} finally {
		delete process.env.LIX_CI_ARTIFACT_API_ROOT;
		delete process.env.LIXRAY_LIX_ARTIFACTS;
		await fixture.close();
	}
});

test("optional artifact misses return immediately for an explicit source fallback", async () => {
	const revision = "d".repeat(40);
	const fixture = await artifactApiFixture({ archive: new Uint8Array(), revision, missing: true });
	try {
		process.env.LIX_CI_ARTIFACT_API_ROOT = fixture.url;
		assert.equal(await installServerImageArtifact({ revision, destination: "unused", log() {} }), undefined);
		assert.equal(fixture.requests.length, 1);
	} finally {
		delete process.env.LIX_CI_ARTIFACT_API_ROOT;
		await fixture.close();
	}
});

test("required artifact lookup errors do not silently fall back to a source build", async () => {
	const revision = "e".repeat(40);
	const fixture = await artifactApiFixture({ archive: new Uint8Array(), revision, lookupStatus: 503 });
	try {
		process.env.LIX_CI_ARTIFACT_API_ROOT = fixture.url;
		process.env.LIXRAY_LIX_ARTIFACTS = "only";
		await assert.rejects(installServerImageArtifact({ revision, destination: "unused", log() {} }), /could not be checked.*503.*Check its producer/);
		assert.equal(fixture.requests.length, 1);
	} finally {
		delete process.env.LIX_CI_ARTIFACT_API_ROOT;
		delete process.env.LIXRAY_LIX_ARTIFACTS;
		await fixture.close();
	}
});

async function artifactApiFixture({ archive, revision, successful, missing = false, lookupStatus = 200 }) {
	const requests = [];
	const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
	const server = createServer((request, response) => {
		requests.push(request.url);
		if (request.url?.startsWith("/repos/opral/lix/actions/artifacts")) {
			if (lookupStatus !== 200) { response.writeHead(lookupStatus).end(); return; }
			json(response, {
				artifacts: missing ? [] : [
					{
						archive_download_url: `${fixtureUrl(server)}/artifact.zip`,
						digest,
						expired: false,
						id: 7,
						workflow_run: { head_sha: revision, id: 42 },
					},
				],
			});
			return;
		}
		if (request.url === "/repos/opral/lix/actions/runs/42") {
			json(response, {
				conclusion: successful ? "success" : null,
				status: successful ? "completed" : "in_progress",
			});
			return;
		}
		if (request.url === "/artifact.zip") {
			response.writeHead(200, { "content-type": "application/zip" });
			response.end(archive);
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
		url: fixtureUrl(server),
	};
}

function fixtureUrl(server) {
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing address");
	return `http://127.0.0.1:${address.port}`;
}

function json(response, value) {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}
