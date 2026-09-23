import { publishedResponseError } from "./published-error.ts";
import type { Lix } from "@lix-js/sdk";

/** UUIDs keep their identity in Lix; this is only their URL representation. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntityKind = "file" | "directory";

/** The verb an entity URL carries: /file/… for files, /folder/… for folders. */
export function entityUrlVerb(kind: EntityKind): "file" | "folder" {
	return kind === "directory" ? "folder" : "file";
}

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

/**
 * Entity URLs resolve by id. A readable browser URL may append a slugified
 * path, such as `/file/<id>/gtm/gtm-playbook.md`; the stored URL stops at the
 * id. A missing or stale display path is rewritten on open.
 */
export function parseEntityUrlSplat(splat: string | undefined): {
	id: string;
	token: string;
	/** The trailing path the URL claims, as slugified segments. */
	path?: string;
	/** Its last segment: the name the URL reads as. */
	name?: string;
} | null {
	const match = /^([A-Za-z0-9_-]{22})(?:\/(.*))?$/.exec(
		(splat ?? "").replace(/\/+$/, ""),
	);
	if (!match) return null;
	let id: string;
	try {
		id = decodeEntityId(match[1]!);
	} catch {
		return null;
	}
	// A splat reaches this both decoded (router params) and raw (a pathname
	// sliced by hand), so each segment is decoded defensively.
	const segments = (match[2] ?? "")
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
	return {
		id,
		token: match[1]!,
		...(segments.length > 0
			? { path: `/${segments.join("/")}`, name: segments.at(-1)! }
			: {}),
	};
}

/**
 * A path segment as a URL reads it: lowercase, punctuation and whitespace
 * collapsed to hyphens, length bounded. The URL's path is for a human
 * skimming it, so "GTM playbook.md" becomes "gtm-playbook.md"; the id beside
 * it is what actually resolves.
 */
function slugSegment(segment: string): string {
	return Array.from(
		segment
			.normalize("NFC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}.-]+/gu, "-")
			// A hyphen next to the dot is punctuation that became a hyphen:
			// "plan (final).md" reads as plan-final.md, not plan-final-.md.
			.replace(/-+\./g, ".")
			.replace(/\.-+/g, ".")
			.replace(/^-+|-+$/g, ""),
	)
		.slice(0, 120)
		.join("");
}

export function entityUrlSplat(id: string, path: string): string {
	const segments = path
		.split("/")
		.map(slugSegment)
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..");
	return [encodeEntityId(id), ...segments].join("/");
}

/**
 * The splat the URL should carry for this entity, or null when it already
 * does. A URL that names no path, or a path the entity has outgrown (renamed,
 * moved, or simply mistyped), is rewritten from the id, which never changes.
 * The comparison is against the slugified path, so a URL that already reads
 * right is left alone.
 */
export function canonicalEntitySplat(
	splat: string | undefined,
	entity: { id: string; path: string },
): string | null {
	const canonical = entityUrlSplat(entity.id, entity.path);
	const current = parseEntityUrlSplat(splat);
	if (!current || current.id !== entity.id) return canonical;
	// A trailing slash is a deviation like any other: the canonical URL has
	// none, so the parse's normalization must not hide it.
	if ((splat ?? "").endsWith("/")) return canonical;
	return `${current.token}${current.path ?? ""}` === canonical
		? null
		: canonical;
}

export function entityRouteBase(
	namespace: string,
	repository: string,
	kind: EntityKind,
	id: string,
): string {
	return `/@${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}/${entityUrlVerb(kind)}/${encodeEntityId(id)}`;
}

export function entityRoutePath(
	namespace: string,
	repository: string,
	kind: EntityKind,
	id: string,
	path: string,
): string {
	const suffix = entityUrlSplat(id, path)
		.split("/")
		.slice(1)
		.map(encodeURIComponent)
		.join("/");
	return `${entityRouteBase(namespace, repository, kind, id)}${suffix ? `/${suffix}` : ""}`;
}

export function entityFromRoute(
	pathname: string,
	namespace: string,
	repository: string,
): { id: string; kind: EntityKind } | null {
	const root = `/@${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}`;
	for (const verb of ["file", "folder"] as const) {
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
	if (!response.ok) throw new Error(await publishedResponseError(response));
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
