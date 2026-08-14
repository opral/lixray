import { z } from "zod";

const lixLookupRows = z
	.array(
		z.object({
			lix_id: z.uuid(),
			can_edit: z.boolean(),
		}),
	)
	.max(1);

type LixLookupResult =
	| { ok: true; lixId: string }
	| { ok: false; reason: "not_found" | "unavailable" };

interface ResolveSupabaseLixOptions {
	supabaseUrl: string;
	publishableKey: string;
	accessToken: string;
	namespace: string;
	lixSlug: string;
	fetch?: typeof fetch;
}

/** Resolves one RLS-visible lix from its public URL identity. */
export async function resolveSupabaseLixId(
	options: ResolveSupabaseLixOptions,
): Promise<LixLookupResult> {
	const lookupUrl = new URL(
		"/rest/v1/rpc/resolve_public_lix_by_route",
		options.supabaseUrl,
	);

	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(lookupUrl, {
			method: "POST",
			headers: {
				apikey: options.publishableKey,
				Authorization: `Bearer ${options.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				p_namespace_handle: options.namespace,
				p_lix_slug: options.lixSlug,
			}),
		});
	} catch {
		return { ok: false, reason: "unavailable" };
	}
	if (!response.ok) return { ok: false, reason: "unavailable" };

	try {
		const rows = lixLookupRows.safeParse(await response.json());
		if (!rows.success) return { ok: false, reason: "unavailable" };
		const lix = rows.data[0];
		return lix?.can_edit
			? { ok: true, lixId: lix.lix_id }
			: { ok: false, reason: "not_found" };
	} catch {
		return { ok: false, reason: "unavailable" };
	}
}
