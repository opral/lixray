import type { WorkerEnv } from "./handler.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type EntityKind = "file" | "directory";
export type EntityLookup = (
	lixId: string,
	kind: EntityKind,
	selector: { id: string } | { path: string },
) => Promise<{ id: string; path: string } | null>;

/** Resolve identity internally, then check the live path before returning anything. */
export async function handlePublishedEntity(
	request: Request,
	env: WorkerEnv,
	lookup: EntityLookup,
	authorize: (lixId: string, path: string) => Promise<boolean>,
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	const reply = (body: unknown, status = 200) =>
		Response.json(body, { status, headers: { "cache-control": "no-store" } });
	if (request.method !== "GET")
		return reply({ error: "Method not allowed" }, 405);
	const params = new URL(request.url).searchParams;
	const namespace = params.get("namespace");
	const repository = params.get("repository");
	const kind = params.get("kind");
	const id = params.get("id");
	const path = params.get("path");
	if (
		!namespace ||
		!repository ||
		!/^[a-z0-9-]{1,100}$/.test(namespace) ||
		!/^[a-z0-9-]{1,100}$/.test(repository) ||
		(kind !== "file" && kind !== "directory") ||
		(id ? !UUID.test(id) || path !== null : !path?.startsWith("/"))
	)
		return reply({ error: "Invalid entity locator" }, 400);
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
		return reply({ error: "Entity resolution unavailable" }, 503);
	let stage = "namespace";
	try {
		const headers = {
			apikey: env.SUPABASE_SERVICE_ROLE_KEY,
			authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
		};
		const handleUrl = new URL("/rest/v1/handles", env.SUPABASE_URL);
		handleUrl.search = new URLSearchParams({
			select: "namespace_id",
			handle: `eq.${namespace}`,
			state: "eq.active",
			limit: "1",
		}).toString();
		const handleResponse = await fetcher(handleUrl, { headers });
		if (!handleResponse.ok)
			throw new Error(
				`Namespace lookup failed (HTTP ${handleResponse.status})`,
			);
		const handles = (await handleResponse.json()) as { namespace_id: string }[];
		if (!handles[0] || !UUID.test(handles[0].namespace_id))
			return reply({ error: "Entity not found" }, 404);
		stage = "repository";
		const repoUrl = new URL("/rest/v1/lixes", env.SUPABASE_URL);
		repoUrl.search = new URLSearchParams({
			select: "id",
			namespace_id: `eq.${handles[0].namespace_id}`,
			slug: `eq.${repository}`,
			deleted_at: "is.null",
			limit: "1",
		}).toString();
		const repoResponse = await fetcher(repoUrl, { headers });
		if (!repoResponse.ok)
			throw new Error(`Repository lookup failed (HTTP ${repoResponse.status})`);
		const repos = (await repoResponse.json()) as { id: string }[];
		const lixId = repos[0]?.id;
		if (!lixId || !UUID.test(lixId))
			return reply({ error: "Entity not found" }, 404);
		stage = "file identity";
		const entity = await lookup(lixId, kind, id ? { id } : { path: path! });
		if (!entity || !(await authorize(lixId, entity.path)))
			return reply({ error: "Entity not found" }, 404);
		return reply({ ...entity, lixId, kind });
	} catch (error) {
		console.error("Published entity resolution failed", { stage, error });
		return reply({ error: "Entity resolution unavailable" }, 502);
	}
}
