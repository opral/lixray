import assert from "node:assert/strict";
import test from "node:test";
import { previewValidationKey } from "./preview-validation-key.mjs";

const input = { tree: "tree", url: "https://preview.example", deploymentId: "deployment", webImage: "web-digest", serverImage: "server-digest", now: 3_600_000 };
test("preview validation reuse requires the same source, deployment, URL and images", () => {
  const key = previewValidationKey(input);
  assert.equal(key, previewValidationKey({ ...input, now: input.now + 1000 }));
  for (const field of ["tree", "url", "deploymentId", "webImage", "serverImage"]) {
    assert.notEqual(key, previewValidationKey({ ...input, [field]: "changed" }), field);
    assert.throws(() => previewValidationKey({ ...input, [field]: "" }), /Missing/);
  }
  assert.notEqual(key, previewValidationKey({ ...input, now: input.now + 3_600_000 }));
});
