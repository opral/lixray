import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveLixServerImage,
	validateLoadedServerImage,
} from "./resolve-lix-server.mjs";

test("reuses a previously published exact-revision feature image", async () => {
	const inspected = [];
	const resolved = await resolveLixServerImage({
		mode: "ci",
		inspectImage: (image) => {
			inspected.push(image);
			return image.includes("/lixray-server:lix-")
				? "sha256:feature-image"
				: undefined;
		},
	});

	assert.equal(resolved.source, "lixray-feature-image");
	assert.equal(
		resolved.image,
		"ghcr.io/opral/lixray-server@sha256:feature-image",
	);
	assert.ok(inspected.some((image) => image.includes("/lix-server:content-")));
	assert.ok(inspected.some((image) => image.includes("/lixray-server:lix-")));
});

test("resolve-only misses return without invoking a source build", async () => {
	const resolved = await resolveLixServerImage({
		mode: "ci",
		allowBuild: false,
		inspectImage: () => undefined,
		installArtifact: async () => undefined,
	});
	assert.equal(resolved.source, "missing");
	assert.equal(resolved.image, "");
});

test("resolve-only registry hits still return the reusable image", async () => {
	const resolved = await resolveLixServerImage({
		mode: "ci",
		allowBuild: false,
		inspectImage: () => "sha256:official-image",
		installArtifact: async () => {
			throw new Error("must not download an artifact");
		},
	});
	assert.equal(resolved.source, "lix-main-image");
	assert.equal(
		resolved.image,
		"ghcr.io/opral/lix-server@sha256:official-image",
	);
});

test("reused server artifacts require a loaded image with matching OCI provenance", async () => {
	let loadedTag;
	const resolved = await resolveLixServerImage({
		mode: "local",
		inspectImage: () => undefined,
		inspectLocalImage: () => false,
		installArtifact: async ({ revision }) => ({ runId: 42, revision }),
		loadImage: () => {},
		inspectLoadedImage: (image) => {
			loadedTag = image;
			const revision = image.split(":")[1];
			return {
				Architecture: "amd64",
				Config: { Labels: { "org.opencontainers.image.revision": revision } },
				Os: "linux",
			};
		},
	});

	assert.match(loadedTag, /^lix-server-ci:[a-f0-9]{40}$/);
	assert.equal(resolved.image, loadedTag);
	assert.equal(resolved.source, "lix-ci-artifact");
});

test("rejects a missing, mislabeled, or non-Linux server artifact image", async () => {
	for (const inspectLoadedImage of [
		() => undefined,
		() => ({
			Architecture: "amd64",
			Config: { Labels: { "org.opencontainers.image.revision": "wrong" } },
			Os: "linux",
		}),
		() => ({
			Architecture: "arm64",
			Config: { Labels: { "org.opencontainers.image.revision": "wrong" } },
			Os: "linux",
		}),
	]) {
		await assert.rejects(
			resolveLixServerImage({
				mode: "local",
				inspectImage: () => undefined,
				inspectLocalImage: () => false,
				installArtifact: async () => ({ runId: 42 }),
				loadImage: () => {},
				inspectLoadedImage,
			}),
			/unexpected OCI provenance or platform/,
		);
	}
});

test("loaded server image validation covers the expected OCI platform fields", () => {
	const revision = "a".repeat(40);
	const valid = {
		Architecture: "amd64",
		Config: { Labels: { "org.opencontainers.image.revision": revision } },
		Os: "linux",
	};
	assert.doesNotThrow(() => validateLoadedServerImage(valid, revision));
	assert.throws(
		() => validateLoadedServerImage({ ...valid, Architecture: "arm64" }, revision),
		/unexpected OCI provenance or platform/,
	);
});
