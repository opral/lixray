import assert from "node:assert/strict";
import test from "node:test";
import { awaitLixArtifacts } from "./await-lix-artifacts.mjs";
import { findOfficialLixServerImage } from "../../scripts/resolve-lix-server.mjs";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

function gateFixture(findServerImage) {
	const waits = [];
	const logs = [];
	return {
		waits,
		logs,
		run: () =>
			awaitLixArtifacts({
				revision,
				findServerImage,
				log: (message) => logs.push(message),
				waitForArtifacts: async (options) => {
					waits.push(options);
					return { available: options.artifactNames, missing: [] };
				},
			}),
	};
}

test("an exact-revision official server image satisfies only the server gate", async () => {
	const inspected = [];
	const fixture = gateFixture((selectedRevision) =>
		findOfficialLixServerImage(selectedRevision, (image) => {
			inspected.push(image);
			return digest;
		}),
	);
	await fixture.run();
	assert.deepEqual(inspected, [`ghcr.io/opral/lix-server:sha-${revision}`]);
	assert.deepEqual(
		fixture.waits.map(({ artifactNames }) => artifactNames),
		[[`lix-browser-sdk-${revision}`]],
	);
	assert.equal(fixture.waits[0].revision, revision);
	assert.ok(
		fixture.logs.some((message) =>
			message.includes(`ghcr.io/opral/lix-server@${digest}`),
		),
	);
});

test("missing official image preserves browser and preview server artifact gates", async () => {
	const fixture = gateFixture((selectedRevision) =>
		findOfficialLixServerImage(selectedRevision, () => undefined),
	);
	await fixture.run();
	assert.deepEqual(fixture.waits[0].artifactNames, [
		`lix-browser-sdk-${revision}`,
		`lix-server-image-linux-x64-${revision}`,
	]);
});

test("a different revision or content tag cannot satisfy the exact-revision gate", async () => {
	const fixture = gateFixture((selectedRevision) =>
		findOfficialLixServerImage(selectedRevision, (image) =>
			image === `ghcr.io/opral/lix-server:sha-${revision}` ? undefined : digest,
		),
	);
	await fixture.run();
	assert.ok(
		fixture.waits[0].artifactNames.includes(
			`lix-server-image-linux-x64-${revision}`,
		),
	);
});

test("an official image does not swallow browser artifact lookup failures", async () => {
	await assert.rejects(
		awaitLixArtifacts({
			revision,
			findServerImage: () => `ghcr.io/opral/lix-server@${digest}`,
			log: () => {},
			waitForArtifacts: async () => {
				throw new Error("Browser artifact lookup failed");
			},
		}),
		/Browser artifact lookup failed/,
	);
});

test("explicit source-build mode skips the registry probe and retains the bypass", async () => {
	const previous = process.env.LIXRAY_LIX_ARTIFACTS;
	process.env.LIXRAY_LIX_ARTIFACTS = "off";
	try {
		const fixture = gateFixture(() => {
			throw new Error("Registry should not be queried");
		});
		await fixture.run();
		assert.deepEqual(fixture.waits[0].artifactNames, [
			`lix-browser-sdk-${revision}`,
			`lix-server-image-linux-x64-${revision}`,
		]);
	} finally {
		if (previous === undefined) delete process.env.LIXRAY_LIX_ARTIFACTS;
		else process.env.LIXRAY_LIX_ARTIFACTS = previous;
	}
});
