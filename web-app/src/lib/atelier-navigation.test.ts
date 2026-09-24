import assert from "node:assert/strict";
import test from "node:test";
import {
	conversationFromViewState,
	conversationSlugText,
} from "./atelier-navigation.ts";

const id = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";

void test("a conversation URL is named like its tab", () => {
	assert.equal(
		conversationSlugText({ title: "Launch plan", anchorLabel: "Checkpoint" }),
		"Launch plan",
	);
	assert.equal(
		conversationSlugText({ title: null, anchorLabel: "notes.md › Intro" }),
		"notes.md › Intro",
	);
	assert.equal(
		conversationSlugText({ title: null, anchorLabel: null }),
		"Conversation",
	);
});

void test("an activated conversation view names its conversation", () => {
	// Opened, not yet read: the id alone.
	assert.deepEqual(conversationFromViewState({ conversationId: id }), {
		conversationId: id,
		slugText: null,
	});
	// Read: the title wins over the tab label.
	assert.deepEqual(
		conversationFromViewState({
			conversationId: id,
			title: "Launch plan",
			atelier: { label: "Launch plan" },
		}),
		{ conversationId: id, slugText: "Launch plan" },
	);
	// Untitled: the tab label (what it is attached to).
	assert.deepEqual(
		conversationFromViewState({
			conversationId: id.toUpperCase(),
			title: null,
			atelier: { label: "Checkpoint" },
		}),
		{ conversationId: id, slugText: "Checkpoint" },
	);
	for (const state of [
		undefined,
		null,
		"x",
		{},
		{ conversationId: "not-a-uuid" },
		{ conversationId: 7 },
	])
		assert.equal(conversationFromViewState(state), null);
});
