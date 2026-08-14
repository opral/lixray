import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	isTeamInviteToken,
	peekTeamInvite,
	stageTeamInvite,
	stagedTeamInviteForRoute,
	takeTeamInvite,
} from "./team-invite.ts";

const originalWindow = globalThis.window;

afterEach(() => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: originalWindow,
	});
});

void test("team invite tokens survive sign-in and are consumed once", () => {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			sessionStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				removeItem: (key: string) => values.delete(key),
				setItem: (key: string, value: string) => values.set(key, value),
			},
		},
	});

	const token = "tm_AAAAAAAAAAAAAAAAAAAA";
	const invite = {
		token,
		namespace: "atelier",
		workspaceSlug: "website",
	} as const;
	stageTeamInvite(invite);
	assert.deepEqual(peekTeamInvite(), invite);
	assert.deepEqual(takeTeamInvite(), invite);
	assert.equal(peekTeamInvite(), null);
	assert.equal(takeTeamInvite(), null);
});

void test("staged team invites are only accepted on their intended route", () => {
	const invite = {
		token: "tm_AAAAAAAAAAAAAAAAAAAA" as const,
		namespace: "atelier",
		workspaceSlug: "website",
	};
	assert.equal(
		stagedTeamInviteForRoute(invite, "atelier", "website"),
		invite.token,
	);
	assert.equal(stagedTeamInviteForRoute(invite, "other", "website"), null);
	assert.equal(stagedTeamInviteForRoute(invite, "atelier", "other"), null);
});

void test("team invite token validation rejects other share tokens", () => {
	assert.equal(isTeamInviteToken("tm_AAAAAAAAAAAAAAAAAAAA"), true);
	assert.equal(isTeamInviteToken("sh_AAAAAAAAAAAAAAAAAAAA"), false);
	assert.equal(isTeamInviteToken("tm_short"), false);
});

void test("pending invites are empty during server rendering", () => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: undefined,
	});
	assert.equal(peekTeamInvite(), null);
	assert.equal(takeTeamInvite(), null);
});
