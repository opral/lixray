import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_EVENTS } from "./telemetry-events.ts";

void test("product telemetry uses one unique semantic object_action taxonomy", () => {
	const events = Object.values(PRODUCT_EVENTS);
	assert.equal(new Set(events).size, events.length);
	for (const event of events) {
		assert.match(event, /^[a-z][a-z0-9]*_[a-z][a-z0-9_]*$/u);
		assert.doesNotMatch(event, /^(?:webapp|mcp|lixray)_/u);
	}
});

void test("signup has one surface-neutral event", () => {
	assert.equal(PRODUCT_EVENTS.userSignedUp, "user_signed_up");
	assert.equal(
		Object.values(PRODUCT_EVENTS).filter((event) => event.endsWith("signed_up"))
			.length,
		1,
	);
});
