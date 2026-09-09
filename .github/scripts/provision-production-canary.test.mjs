import assert from "node:assert/strict";
import test from "node:test";
import { provisionProductionCanary } from "./provision-production-canary.mjs";
const env = {
  LIXRAY_CANARY_LIX_URL: "https://lixray.example/lix/11111111-1111-4111-8111-111111111111",
  RAILWAY_PRODUCTION_ENVIRONMENT: "production",
  RAILWAY_TARGET_ENVIRONMENT: "wrong-preview",
};
test("adopts only the configured canary in the production environment", () => {
  let calls = 0;
  provisionProductionCanary({ env, spawnImpl(command, args, options) {
    calls++;
    assert.equal(command, "bash");
    assert.deepEqual(args.slice(1), ["adopt-existing", "11111111-1111-4111-8111-111111111111"]);
    assert.equal(options.env.PREVIEW_URL, "https://lixray.example");
    assert.equal(options.env.RAILWAY_TARGET_ENVIRONMENT, "production");
    return { status: 0 };
  }});
  assert.equal(calls, 1);
});
test("failed adoption stops promotion without a create fallback", () => {
  let calls = 0;
  assert.throws(() => provisionProductionCanary({env, spawnImpl() { calls++; return {status: 17}; }}), /adoption failed/);
  assert.equal(calls, 1);
});
test("rejects unsafe canary URLs before invoking SSH", () => {
  for (const url of ["http://lixray.example/lix/a", env.LIXRAY_CANARY_LIX_URL + "?token=secret", "https://user:password@lixray.example/lix/a", "https://lixray.example/lix/$(whoami)"]) {
    assert.throws(() => provisionProductionCanary({env: {...env, LIXRAY_CANARY_LIX_URL: url}, spawnImpl() { assert.fail("must not spawn"); }}));
  }
});
