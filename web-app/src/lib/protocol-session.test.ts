import assert from "node:assert/strict";
import test from "node:test";
import {
	createProtocolSessionRecovery,
	isProtocolSessionGoneError,
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

void test("recognizes protocol-session-gone errors from status, code, and message", () => {
	assert.equal(
		isProtocolSessionGoneError(
			Object.assign(new Error("Remote session expired"), {
				code: REMOTE_SESSION_EXPIRED_CODE,
				status: 410,
			}),
		),
		true,
	);
	assert.equal(
		isProtocolSessionGoneError(
			Object.assign(
				new Error(
					"the Lix protocol session is unknown, expired, or closed; open a new client session",
				),
				{ code: PROTOCOL_SESSION_GONE_CODE },
			),
		),
		true,
	);
	assert.equal(
		isProtocolSessionGoneError(
			new Error("A repository access token is required."),
		),
		false,
	);
});

void test("recovers a gone session once per generation and remounts a new epoch", () => {
	const recovery = createProtocolSessionRecovery({ maxRecoveries: 2 });

	assert.equal(recovery.recover(), true);
	assert.equal(recovery.getEpoch(), 1);
	assert.equal(recovery.recover(), false);
	assert.equal(recovery.getEpoch(), 1);

	recovery.markReady();
	assert.equal(recovery.recover(), true);
	assert.equal(recovery.getEpoch(), 2);

	recovery.markReady();
	assert.equal(recovery.recover(), false);
	assert.equal(recovery.getEpoch(), 2);

	recovery.resetBudget();
	assert.equal(recovery.recover(), true);
	assert.equal(recovery.getEpoch(), 3);
});
