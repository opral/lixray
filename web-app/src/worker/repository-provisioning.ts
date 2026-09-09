import type { WorkerEnv } from "./handler.ts";
import { lixServiceRequestHeaders } from "../lib/lix-service-proxy.ts";
/** Explicit creation/adoption after the gateway has checked repository membership. */
export async function provisionLixService(
	env: WorkerEnv,
	lixId: string,
	token: string,
	accountId: string,
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	const isApiToken = token.startsWith("lixray_pat_");
	const metadata = await fetcher(
		new URL("/rest/v1/rpc/resolve_lix_provision_mode", env.SUPABASE_URL),
		{
			method: "POST",
			headers: {
				apikey: env.SUPABASE_PUBLISHABLE_KEY ?? "",
				"content-type": "application/json",
				...(!isApiToken ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				p_lix_id: lixId,
				p_api_token: isApiToken ? token : null,
			}),
		},
	);
	if (!metadata.ok)
		return new Response("Repository provisioning metadata is unavailable", {
			status: 502,
		});
	const rows = (await metadata.json()) as Array<{
		storage_provision_mode?: string;
	}>;
	const mode = rows[0]?.storage_provision_mode;
	if (mode !== "create-new" && mode !== "adopt-existing")
		return new Response("Repository provisioning metadata is unavailable", {
			status: 409,
		});
	const serviceUrl =
		env.LIXRAY_LIX_SERVICE_URL ??
		env.LIXRAY_REPOSITORY_SERVICE_URL ??
		env.LIXRAY_WORKSPACE_SERVICE_URL;
	if (!serviceUrl || !env.LIXRAY_INTERNAL_TOKEN)
		return new Response("Repository provisioning is not configured", {
			status: 503,
		});
	const url = new URL(
		`/internal/repositories/${encodeURIComponent(lixId)}/provision`,
		serviceUrl,
	);
	return fetcher(url, {
		method: "POST",
		headers: lixServiceRequestHeaders(
			new Headers({
				"content-type": "application/json",
				"x-lixray-idempotency-principal": accountId,
			}),
			env.LIXRAY_INTERNAL_TOKEN,
		),
		body: JSON.stringify({ mode }),
	});
}
