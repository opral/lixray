import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_EXCEPTION_CAPTURE_CONFIG } from "./telemetry-exceptions.ts";

void test("captures browser exceptions without converting console errors", () => {
	assert.deepEqual(BROWSER_EXCEPTION_CAPTURE_CONFIG, {
		capture_unhandled_errors: true,
		capture_unhandled_rejections: true,
		capture_console_errors: false,
	});
});
