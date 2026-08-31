import assert from "node:assert/strict";
import test from "node:test";
import { resolveLixServerImage } from "./resolve-lix-server.mjs";

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
