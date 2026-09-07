import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("preview protocol probe matches the selected Lix sync protocol", async () => {
	const [workflow, sync] = await Promise.all([
		readFile(new URL("../workflows/pr.yml", import.meta.url), "utf8"),
		readFile(
			new URL("../../vendor/lix/packages/lix/src/sync/mod.rs", import.meta.url),
			"utf8",
		),
	]);
	const probeVersion = workflow.match(/sync_protocol_version=(\d+)/u)?.[1];
	const sdkVersion = sync.match(
		/const SYNC_PROTOCOL_VERSION: u32 = (\d+);/u,
	)?.[1];
	assert.ok(
		probeVersion,
		"preview probe must declare its sync protocol version",
	);
	assert.ok(sdkVersion, "selected SDK must declare its sync protocol version");
	assert.equal(
		probeVersion,
		sdkVersion,
		"update the preview probe with the SDK pin",
	);
});
