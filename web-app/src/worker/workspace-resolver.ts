import { z } from "zod";

const workspaceLookupRows = z
	.array(
		z.object({
			id: z.uuid(),
		}),
	)
	.max(1);

export type WorkspaceLookupResult =
	| { ok: true; workspaceId: string }
	| { ok: false; reason: "not_found" | "unavailable" };

export interface ResolveSupabaseWorkspaceOptions {
	supabaseUrl: string;
	publishableKey: string;
	accessToken: string;
	namespace: string;
	workspaceSlug: string;
	fetch?: typeof fetch;
}

/** Resolves one RLS-visible workspace from its public URL identity. */
export async function resolveSupabaseWorkspaceId(
	options: ResolveSupabaseWorkspaceOptions,
): Promise<WorkspaceLookupResult> {
	const lookupUrl = new URL("/rest/v1/workspaces", options.supabaseUrl);
	lookupUrl.searchParams.set("select", "id,organizations!inner(id)");
	lookupUrl.searchParams.set("slug", `eq.${options.workspaceSlug}`);
	lookupUrl.searchParams.set("deleted_at", "is.null");
	lookupUrl.searchParams.set("organizations.handle", `eq.${options.namespace}`);
	lookupUrl.searchParams.set("limit", "1");

	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(lookupUrl, {
			headers: {
				apikey: options.publishableKey,
				Authorization: `Bearer ${options.accessToken}`,
				Accept: "application/json",
			},
		});
	} catch {
		return { ok: false, reason: "unavailable" };
	}
	if (!response.ok) return { ok: false, reason: "unavailable" };

	try {
		const rows = workspaceLookupRows.safeParse(await response.json());
		if (!rows.success) return { ok: false, reason: "unavailable" };
		const workspace = rows.data[0];
		return workspace
			? { ok: true, workspaceId: workspace.id }
			: { ok: false, reason: "not_found" };
	} catch {
		return { ok: false, reason: "unavailable" };
	}
}
