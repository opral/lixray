import assert from "node:assert/strict";
import test from "node:test";
import {
	isProtocolSessionGoneStatus,
	PROTOCOL_SESSION_GONE_CODE,
	protocolSessionGoneErrorCode,
	REMOTE_SESSION_EXPIRED_CODE,
} from "./protocol-session.ts";

void test("treats HTTP 410 as a gone protocol session", () => {
	assert.equal(isProtocolSessionGoneStatus(410), true);
	assert.equal(
		isProtocolSessionGoneStatus(503, PROTOCOL_SESSION_GONE_CODE),
		true,
	);
	assert.equal(isProtocolSessionGoneStatus(500), false);
	assert.equal(protocolSessionGoneErrorCode(410), PROTOCOL_SESSION_GONE_CODE);
	assert.equal(
		protocolSessionGoneErrorCode(410, REMOTE_SESSION_EXPIRED_CODE),
		REMOTE_SESSION_EXPIRED_CODE,
	);
});
