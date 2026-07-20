import assert from "node:assert/strict";
import { test } from "node:test";
import { peekWorkspaceShareJoinIntent } from "./workspace-share-capability.ts";

void test("share join intent is empty during server rendering", () => {
	assert.equal(peekWorkspaceShareJoinIntent(), null);
});
