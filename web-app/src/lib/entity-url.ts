import type { Lix } from "@lix-js/sdk";

/** UUIDs keep their identity in Lix; this is only their URL representation. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntityKind = "file" | "directory";

export async function findLixEntity(
	lix: Pick<Lix, "execute">,
	kind: EntityKind,
	lookup: { id: string } | { path: string },
): Promise<{ id: string; path: string } | null> {
	const table = kind === "file" ? "lix_file" : "lix_directory";
	const column = "id" in lookup ? "id" : "path";
	const value =
		"id" in lookup ? lookup.id : lookup.path.replace(/\/$/, "") || "/";
	const result = await lix.execute(
		`SELECT id, path FROM ${table} WHERE ${column} = $1`,
		[value],
	);
	const row = result.rows[0];
	return row && typeof row.id === "string" && typeof row.path === "string"
		? { id: row.id, path: row.path }
		: null;
}

export function encodeEntityId(id: string): string {
	if (!UUID.test(id)) throw new Error("Invalid entity UUID");
	const hex = id.replaceAll("-", "");
	let bytes = "";
	for (let index = 0; index < hex.length; index += 2) {
		bytes += String.fromCharCode(
			Number.parseInt(hex.slice(index, index + 2), 16),
		);
	}
	return btoa(bytes)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

export function decodeEntityId(token: string): string {
	if (!/^[A-Za-z0-9_-]{22}$/.test(token))
		throw new Error("Invalid entity URL ID");
	const bytes = atob(token.replaceAll("-", "+").replaceAll("_", "/") + "==");
	const hex = Array.from(bytes, (byte) =>
		byte.charCodeAt(0).toString(16).padStart(2, "0"),
	).join("");
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	// Reject aliases whose unused padding bits decode to the same UUID.
	if (bytes.length !== 16 || encodeEntityId(id) !== token)
		throw new Error("Noncanonical entity URL ID");
	return id;
}

export function parseEntityUrlSplat(
	splat: string | undefined,
): { id: string; token: string; slug?: string } | null {
	const match = /^([A-Za-z0-9_-]{22})(?:\/([^/]+))?\/?$/.exec(splat ?? "");
	if (!match) return null;
	try {
		return {
			id: decodeEntityId(match[1]!),
			token: match[1]!,
			...(match[2] ? { slug: match[2] } : {}),
		};
	} catch {
		return null;
	}
}

export function entityUrlSplat(id: string, path: string): string {
	const name = path.split("/").filter(Boolean).at(-1) ?? "";
	const slug = Array.from(
		name
			.normalize("NFC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}.-]+/gu, "-")
			.replace(/^-+|-+$/g, ""),
	)
		.slice(0, 120)
		.join("");
	return (
		encodeEntityId(id) +
		(slug && slug !== "." && slug !== ".." ? `/${slug}` : "")
	);
}

export function entityRoutePath(
	namespace: string,
	repository: string,
	kind: EntityKind,
	id: string,
	path: string,
): string {
	const splat = entityUrlSplat(id, path)
		.split("/")
		.map(encodeURIComponent)
		.join("/");
	return `/@${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}/${kind === "directory" ? "dir" : "file"}/${splat}`;
}

export function entityFromRoute(
	pathname: string,
	namespace: string,
	repository: string,
): { id: string; kind: EntityKind } | null {
	const root = `/@${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}`;
	for (const verb of ["file", "dir"] as const) {
		const prefix = `${root}/${verb}/`;
		if (!pathname.startsWith(prefix)) continue;
		const entity = parseEntityUrlSplat(pathname.slice(prefix.length));
		return entity
			? { id: entity.id, kind: verb === "file" ? "file" : "directory" }
			: null;
	}
	return null;
}

export async function resolvePublishedEntity(args: {
	namespace: string;
	repository: string;
	kind: EntityKind;
	id?: string;
	path?: string;
	signal?: AbortSignal;
}): Promise<{
	id: string;
	kind: EntityKind;
	path: string;
	lixId: string;
} | null> {
	const query = new URLSearchParams({
		namespace: args.namespace,
		repository: args.repository,
		kind: args.kind,
	});
	if (args.id) query.set("id", args.id);
	if (args.path) query.set("path", args.path);
	const response = await fetch(`/api/published/entity?${query}`, {
		signal: args.signal,
	});
	if (response.status === 404) return null;
	if (!response.ok)
		throw new Error("This item could not be found or is no longer public.");
	const data: unknown = await response.json();
	if (
		!data ||
		typeof data !== "object" ||
		!("id" in data) ||
		typeof data.id !== "string" ||
		!UUID.test(data.id) ||
		!("kind" in data) ||
		data.kind !== args.kind ||
		!("path" in data) ||
		typeof data.path !== "string" ||
		!("lixId" in data) ||
		typeof data.lixId !== "string" ||
		(args.id && data.id !== args.id)
	) {
		throw new Error("Invalid published item response.");
	}
	return { id: data.id, kind: args.kind, path: data.path, lixId: data.lixId };
}
