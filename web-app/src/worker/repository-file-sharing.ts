import type { WorkerEnv } from "./handler.ts";

/** Uses the caller's existing control-plane permissions; never a service credential. */
export async function handleFileSharing(
	request: Request,
	env: WorkerEnv,
	token: string,
	id: string,
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.searchParams.get("path");
	if (
		!path ||
		!path.startsWith("/") ||
		path === "/" ||
		path.includes("\\") ||
		[...path].some((character) => character.charCodeAt(0) < 32) ||
		path
			.split("/")
			.slice(1)
			.some((part) => !part || part === "." || part === "..")
	)
		return Response.json(
			{ error: "A canonical file path is required." },
			{ status: 400 },
		);
	if (!["GET", "POST", "DELETE"].includes(request.method))
		return new Response(null, { status: 405 });
	const rpc = async (name: string, args: object = {}): Promise<unknown> => {
		const response = await fetcher(
			new URL(`/rest/v1/rpc/${name}`, env.SUPABASE_URL),
			{
				method: "POST",
				headers: {
					apikey: env.SUPABASE_PUBLISHABLE_KEY ?? "",
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(args),
			},
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Sharing permission could not be verified. Try again.");
		}
		return response.status === 204 ? null : (await response.json()) as unknown;
	};
	try {
		const repos = (await rpc("list_accessible_lixes")) as Array<{
			lix_id: string;
			lix_visibility: string;
			namespace_handle: string;
			lix_slug: string;
		}>;
		const repository = repos.find((repo) => repo.lix_id === id);
		if (!repository)
			return Response.json({ error: "Repository not found." }, { status: 404 });
		const publications = (await rpc("list_lix_publications", {
			p_lix_id: id,
		})) as Array<{ kind: string; path: string }>;
		const inherited =
			repository.lix_visibility === "public" ||
			publications.some(
				(p) =>
					p.kind === "directory" &&
					(p.path === "/" || path.startsWith(`${p.path}/`)),
			);
		if (request.method === "DELETE" && inherited)
			return Response.json(
				{
					error:
						"This file is published through its folder or repository. Manage that publication on Lixray.",
				},
				{ status: 409 },
			);
		if (request.method !== "GET")
			await rpc(
				request.method === "POST"
					? "publish_lix_resource"
					: "unpublish_lix_resource",
				{ p_lix_id: id, p_path: path, p_kind: "file" },
			);
		const published =
			inherited ||
			(request.method === "POST"
				? true
				: request.method === "DELETE"
					? false
					: publications.some((p) => p.kind === "file" && p.path === path));
		const fileUrl = new URL(
			`/@${encodeURIComponent(repository.namespace_handle)}/${encodeURIComponent(repository.lix_slug)}/file/${path.slice(1).split("/").map(encodeURIComponent).join("/")}`,
			url,
		).href;
		return Response.json(
			{ published, inherited, url: fileUrl },
			{ headers: { "cache-control": "no-store" } },
		);
	} catch {
		return Response.json(
			{ error: "Sharing is unavailable. Check your access and try again." },
			{ status: 503 },
		);
	}
}
