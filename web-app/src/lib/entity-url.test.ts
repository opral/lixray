import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	decodeEntityId,
	encodeEntityId,
	entityRouteBase,
	entityRoutePath,
	entityUrlSplat,
	parseEntityUrlSplat,
	entityFromRoute,
	canonicalEntitySplat,
	resolveLixEntityForRoute,
	resolvePublishedEntity,
	conversationUrlSplat,
	canonicalConversationSplat,
	conversationRouteBase,
	conversationRoutePath,
	conversationFromRoute,
} from "./entity-url.ts";
import type { Lix } from "@lix-js/sdk";

const uuid = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";
const token = "AX8i4nmwfMOYxNwMDAc5jw";

function routeLookupLix({
	rows = [],
	observedRows = [],
	onObserve,
}: {
	rows?: readonly object[];
	observedRows?: readonly (readonly object[])[];
	onObserve?: (
		sql: string,
		params: readonly unknown[],
		signal: AbortSignal | undefined,
		emit: (rows: readonly object[]) => void,
	) => void;
} = {}): Pick<Lix, "execute" | "observe"> & {
	readonly observeReturnCount: number;
} {
	let returnCount = 0;
	const lix = {
		execute: async () => ({ rows: [...rows] }),
		observe: (
			sql: string,
			params: unknown[] = [],
			options: { signal?: AbortSignal } = {},
		) => {
			let index = 0;
			let closed = false;
			const observed: (readonly object[])[] = [...observedRows];
			let waiter:
				| ((
						result: IteratorResult<{ result: { rows: readonly object[] } }>,
				  ) => void)
				| undefined;
			const emit = (nextRows: readonly object[]) => {
				if (closed) return;
				if (waiter) {
					const resolve = waiter;
					waiter = undefined;
					resolve({ done: false, value: { result: { rows: nextRows } } });
				} else {
					observed.push(nextRows);
				}
			};
			const iterator: AsyncIterableIterator<{
				result: { rows: readonly object[] };
			}> = {
				[Symbol.asyncIterator]() {
					return this;
				},
				next() {
					if (index < observed.length) {
						return Promise.resolve({
							done: false as const,
							value: { result: { rows: observed[index++]! } },
						});
					}
					if (closed)
						return Promise.resolve({ done: true as const, value: undefined });
					return new Promise((resolve) => {
						waiter = resolve;
					});
				},
				async return() {
					returnCount++;
					closed = true;
					waiter?.({ done: true, value: undefined });
					waiter = undefined;
					return { done: true as const, value: undefined };
				},
				throw(error?: unknown) {
					return Promise.reject(
						error instanceof Error
							? error
							: new Error("Observation failed", { cause: error }),
					);
				},
			};
			onObserve?.(sql, params, options.signal, emit);
			options.signal?.addEventListener(
				"abort",
				() => {
					void iterator.return?.();
				},
				{ once: true },
			);
			return iterator;
		},
	};
	return {
		...lix,
		get observeReturnCount() {
			return returnCount;
		},
	} as unknown as Pick<Lix, "execute" | "observe"> & {
		readonly observeReturnCount: number;
	};
}

void test("UUID bytes use canonical unpadded Base64url across runtimes", () => {
	assert.equal(encodeEntityId(uuid), token);
	assert.equal(encodeEntityId(uuid.toUpperCase()), token);
	assert.equal(decodeEntityId(token), uuid);
	for (let index = 0; index < 1000; index++) {
		const bytes = createHash("sha256")
			.update(String(index))
			.digest()
			.subarray(0, 16);
		const encoded = bytes.toString("base64url");
		assert.equal(encodeEntityId(decodeEntityId(encoded)), encoded);
	}
});

void test("malformed and noncanonical tokens cannot alias an entity", () => {
	for (const invalid of [
		"",
		uuid,
		token + "=",
		token.slice(1),
		token + "/",
		token.slice(0, -1) + "x",
	]) {
		assert.throws(() => decodeEntityId(invalid));
	}
	assert.throws(() => encodeEntityId("not-a-uuid"));
});

void test("an entity URL reads as the path it opens, slugified", () => {
	assert.equal(
		entityUrlSplat(uuid, "/gtm/GTM playbook.md"),
		`${token}/gtm/gtm-playbook.md`,
	);
	assert.equal(
		entityRoutePath("opral", "monorepo", "file", uuid, "/gtm/GTM playbook.md"),
		`/@opral/monorepo/file/${token}/gtm/gtm-playbook.md`,
	);
	assert.equal(
		entityRouteBase("opral", "monorepo", "file", uuid),
		`/@opral/monorepo/file/${token}`,
	);
	// Folders read as folders; the root has no path to carry.
	assert.equal(
		entityRoutePath("opral", "monorepo", "directory", uuid, "/teams/GTM"),
		`/@opral/monorepo/folder/${token}/teams/gtm`,
	);
	assert.equal(
		entityRoutePath("opral", "monorepo", "directory", uuid, "/"),
		`/@opral/monorepo/folder/${token}`,
	);
	const parsed = parseEntityUrlSplat(`${token}/gtm/gtm-playbook.md`);
	assert.equal(parsed?.id, uuid);
	assert.equal(parsed?.path, "/gtm/gtm-playbook.md");
	assert.equal(parsed?.name, "gtm-playbook.md");
	assert.equal(parseEntityUrlSplat(token)?.path, undefined);
	assert.equal(parseEntityUrlSplat(`${token}/`)?.path, undefined);
	assert.equal(parseEntityUrlSplat("gtm/GTM playbook.md"), null);
});

void test("the id is the identity; the path is rewritten from it", () => {
	const entity = { id: uuid, path: "/gtm/Correct.md" };
	// A bare id, a stale name, and a path from another folder all resolve to
	// the same file, and each is corrected to the file's own path.
	for (const splat of [
		token,
		`${token}/peter.md`,
		`${token}/old/correct.md`,
		`${token}/gtm/correct.md/`,
	]) {
		assert.equal(parseEntityUrlSplat(splat)?.id, uuid);
		assert.equal(
			canonicalEntitySplat(splat, entity),
			`${token}/gtm/correct.md`,
		);
	}
	// Already right: nothing to rewrite, so the URL is left alone.
	assert.equal(canonicalEntitySplat(`${token}/gtm/correct.md`, entity), null);
	assert.equal(canonicalEntitySplat(token, { id: uuid, path: "/" }), null);
	// Another entity's URL is never silently adopted.
	assert.equal(
		canonicalEntitySplat("AX8i4nmwfMOYxNwMDAc5jw", {
			id: "017f22e2-79b0-7cc3-98c4-dc0c0c07398e",
			path: "/other.md",
		}),
		"AX8i4nmwfMOYxNwMDAc5jg/other.md",
	);
});

void test("folder routes resolve by ID and the /dir alias is absent", () => {
	const entity = entityFromRoute(
		`/@opral/monorepo/folder/${token}/teams/GTM`,
		"opral",
		"monorepo",
	);
	assert.equal(entity?.id, uuid);
	assert.equal(entity?.kind, "directory");
	assert.equal(
		entityFromRoute(`/@opral/monorepo/dir/${token}`, "opral", "monorepo"),
		null,
	);
	assert.equal(
		entityFromRoute(
			`/@opral/monorepo/file/${token}/gtm/correct.md`,
			"opral",
			"monorepo",
		)?.kind,
		"file",
	);
	assert.equal(
		entityFromRoute(`/@opral/other/file/${token}`, "opral", "monorepo"),
		null,
	);
});

void test("partial file and folder routes wait for the exact ID to arrive", async () => {
	for (const kind of ["file", "directory"] as const) {
		let waiting = false;
		const expectedSql = `SELECT id, path FROM lix_${kind} WHERE id = $1`;
		const lix = routeLookupLix({
			observedRows: [[], [{ id: `${uuid}-other`, path: "/wrong.md" }]],
			onObserve(sql, params, _signal, emit) {
				assert.equal(sql, expectedSql);
				assert.deepEqual(params, [uuid]);
				setTimeout(() => emit([{ id: uuid, path: `/${kind}.md` }]), 0);
			},
		});
		const result = await resolveLixEntityForRoute(
			lix,
			kind,
			{ id: uuid },
			{
				policy: "partial_replica",
				signal: new AbortController().signal,
				onWaiting: () => {
					waiting = true;
				},
			},
		);
		assert.equal(waiting, true);
		assert.deepEqual(result, {
			kind: "found",
			entity: { id: uuid, path: `/${kind}.md` },
		});
		assert.ok(lix.observeReturnCount > 0, "resolved observers are closed");
	}
});

void test("authoritative absence remains definitive and never starts an observer", async () => {
	const lix = routeLookupLix({
		onObserve() {
			assert.fail("authoritative absence must not wait on an observer");
		},
	});
	const result = await resolveLixEntityForRoute(
		lix,
		"file",
		{ id: uuid },
		{ policy: "authoritative", signal: new AbortController().signal },
	);
	assert.deepEqual(result, { kind: "missing" });
});

void test("an already materialized entity resolves without opening an observer", async () => {
	const lix = routeLookupLix({ rows: [{ id: uuid, path: "/ready.md" }] });
	const result = await resolveLixEntityForRoute(
		lix,
		"file",
		{ id: uuid },
		{ policy: "partial_replica", signal: new AbortController().signal },
	);
	assert.deepEqual(result, {
		kind: "found",
		entity: { id: uuid, path: "/ready.md" },
	});
	assert.equal(lix.observeReturnCount, 0);
});

void test("a missing partial-replica entity has a bounded retryable result", async () => {
	const lix = routeLookupLix({ observedRows: [[]] });
	const result = await resolveLixEntityForRoute(
		lix,
		"directory",
		{ id: uuid },
		{
			policy: "partial_replica",
			signal: new AbortController().signal,
			timeoutMs: 5,
		},
	);
	assert.deepEqual(result, { kind: "pending" });
	assert.ok(lix.observeReturnCount > 0, "timed out observer is closed");
});

void test("navigation abort closes a pending partial-replica lookup", async () => {
	const controller = new AbortController();
	const lix = routeLookupLix({
		onObserve() {
			setTimeout(() => controller.abort(), 0);
		},
	});
	const lookup = resolveLixEntityForRoute(
		lix,
		"file",
		{ id: uuid },
		{ policy: "partial_replica", signal: controller.signal },
	);
	await assert.rejects(lookup, { name: "AbortError" });
	assert.ok(lix.observeReturnCount > 0, "aborted observer is closed");
});

void test("published lookup distinguishes unavailable items from service failures", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch");
	const args = {
		namespace: "opral",
		repository: "monorepo",
		kind: "file" as const,
		id: uuid,
	};
	fetch.mock.mockImplementation(
		async () => new Response(null, { status: 404 }),
	);
	assert.equal(await resolvePublishedEntity(args), null);
	fetch.mock.mockImplementation(
		async () => new Response(null, { status: 503 }),
	);
	await assert.rejects(resolvePublishedEntity(args));
	fetch.mock.mockImplementation(async () =>
		Response.json({
			id: uuid,
			kind: "directory",
			path: "/private",
			lixId: uuid,
		}),
	);
	await assert.rejects(resolvePublishedEntity(args), /Invalid published/);
	fetch.mock.mockImplementation(async () =>
		Response.json({ id: uuid, kind: "file", path: "/renamed.md", lixId: uuid }),
	);
	assert.equal((await resolvePublishedEntity(args))?.path, "/renamed.md");
});

void test("a slug stays a plain URL segment, whatever the name holds", () => {
	for (const [path, expected] of [
		["/gtm/GTM playbook.md", "/gtm/gtm-playbook.md"],
		["/a b/c#d?e&f.md", "/a-b/c-d-e-f.md"],
		["/100% done/plan (final).md", "/100-done/plan-final.md"],
		// Lowercasing follows the script: Deseret capitals have lowercase forms.
		["/𐐀 unicode/𐐀.md", "/𐐨-unicode/𐐨.md"],
		// A name that slugs to nothing drops out; the id still resolves.
		["/??/keep.md", "/keep.md"],
		["/" + "a".repeat(300) + ".md", "/" + "a".repeat(120)],
	] as const) {
		const url = entityRoutePath("opral", "monorepo", "file", uuid, path);
		const splat = url.split("/file/")[1]!;
		assert.equal(parseEntityUrlSplat(splat)?.path, expected);
		// The router encodes a splat segment by segment the same way, so the
		// URL the app builds is the URL the router navigates to.
		assert.equal(
			splat,
			[
				token,
				...expected.split("/").filter(Boolean).map(encodeURIComponent),
			].join("/"),
		);
	}
});

void test("a conversation URL reads as its title; the id resolves", () => {
	assert.equal(
		conversationUrlSplat(uuid, "Launch plan: Q4 review"),
		`${token}/launch-plan-q4-review`,
	);
	// Untitled conversations read as what they are attached to.
	assert.equal(
		conversationUrlSplat(uuid, "notes.md › Intro"),
		`${token}/notes.md-intro`,
	);
	// A name that slugs to nothing leaves the bare id.
	for (const title of [null, undefined, "", "???", ".", ".."])
		assert.equal(conversationUrlSplat(uuid, title), token);
	// The title is one segment, whatever it holds.
	assert.equal(conversationUrlSplat(uuid, "a/b c"), `${token}/a-b-c`);
	assert.equal(
		conversationRoutePath("opral", "monorepo", uuid, "Launch plan"),
		`/@opral/monorepo/conversation/${token}/launch-plan`,
	);
	assert.equal(
		conversationRoutePath("opral", "monorepo", uuid, null),
		`/@opral/monorepo/conversation/${token}`,
	);
	assert.equal(
		conversationRouteBase("opral", "monorepo", uuid),
		`/@opral/monorepo/conversation/${token}`,
	);
	assert.equal(
		conversationRoutePath("opral", "monorepo", uuid, "𐐀 plan"),
		`/@opral/monorepo/conversation/${token}/${encodeURIComponent("𐐨-plan")}`,
	);
});

void test("a conversation slug is display-only and rewritten from the title", () => {
	const conversation = { id: uuid, title: "Launch plan" };
	for (const splat of [
		token,
		`${token}/`,
		`${token}/old-title`,
		`${token}/launch-plan/`,
		`${token}/launch/plan`,
	]) {
		assert.equal(parseEntityUrlSplat(splat)?.id, uuid);
		assert.equal(
			canonicalConversationSplat(splat, conversation),
			`${token}/launch-plan`,
		);
	}
	assert.equal(
		canonicalConversationSplat(`${token}/launch-plan`, conversation),
		null,
	);
	// Untitled: the bare id is canonical, a leftover slug is dropped.
	assert.equal(
		canonicalConversationSplat(token, { id: uuid, title: null }),
		null,
	);
	assert.equal(
		canonicalConversationSplat(`${token}/stale`, { id: uuid, title: null }),
		token,
	);
	// Another conversation's URL is never silently adopted.
	assert.equal(
		canonicalConversationSplat(token, {
			id: "017f22e2-79b0-7cc3-98c4-dc0c0c07398e",
			title: "Other",
		}),
		"AX8i4nmwfMOYxNwMDAc5jg/other",
	);
});

void test("conversation routes resolve by id within their repository", () => {
	assert.equal(
		conversationFromRoute(
			`/@opral/monorepo/conversation/${token}/launch-plan`,
			"opral",
			"monorepo",
		)?.id,
		uuid,
	);
	assert.equal(
		conversationFromRoute(
			`/@opral/monorepo/conversation/${token}`,
			"opral",
			"monorepo",
		)?.id,
		uuid,
	);
	for (const pathname of [
		`/@opral/other/conversation/${token}`,
		`/@opral/monorepo/threads/${token}`,
		`/@opral/monorepo/file/${token}`,
		`/@opral/monorepo/conversation/not-a-token`,
		`/@opral/monorepo/conversation/${uuid}`,
	])
		assert.equal(conversationFromRoute(pathname, "opral", "monorepo"), null);
	// A conversation is not a file or folder entity.
	assert.equal(
		entityFromRoute(
			`/@opral/monorepo/conversation/${token}`,
			"opral",
			"monorepo",
		),
		null,
	);
});
