import assert from "node:assert/strict";
import { test } from "node:test";
import { peekRepositoryShareJoinIntent } from "./repository-share-capability.ts";

void test("share join intent is empty during server rendering", () => {
	assert.equal(peekRepositoryShareJoinIntent(), null);
});
