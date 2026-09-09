import type { WorkerEnv } from "./handler.ts";
import { hostedRepositoryRpc, readDescriptor } from "./repository-create.ts";
import { lixServiceRequestHeaders } from "../lib/lix-service-proxy.ts";

/** Storage deletion precedes metadata deletion; the same DELETE safely completes a partial failure. */
export async function deleteHostedRepository(
	request: Request,
	id: string,
	env: WorkerEnv,
	account: { userId: string },
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	const failure = (status: number, message: string) =>
		Response.json(
			{ error: { code: "LIX_HOST_DELETION_FAILED", message } },
			{ status },
		);
	const service =
		env.LIXRAY_LIX_SERVICE_URL ??
		env.LIXRAY_REPOSITORY_SERVICE_URL ??
		env.LIXRAY_WORKSPACE_SERVICE_URL;
	if (
		!service ||
		!env.LIXRAY_INTERNAL_TOKEN ||
		!env.SUPABASE_SERVICE_ROLE_KEY ||
		!env.SUPABASE_URL
	)
		return failure(503, "Repository deletion is not configured.");
	const args = { p_lix_id: id, p_account_id: account.userId };
	try {
		const authorization = await hostedRepositoryRpc(
			env,
			"authorize_hosted_lix_deletion",
			args,
			fetcher,
		);
		if (!authorization.ok) {
			await authorization.body?.cancel();
			return failure(
				authorization.status === 403 ? 403 : 503,
				authorization.status === 403
					? "Repository admin access required."
					: "Repository authorization is unavailable.",
			);
		}
		const deleted: unknown = JSON.parse(await readDescriptor(authorization));
		if (typeof deleted !== "boolean")
			return failure(502, "Invalid repository authorization response.");
		if (deleted) return new Response(null, { status: 204 });
		// Build trusted headers rather than forwarding any client principal or scope.
		const headers = lixServiceRequestHeaders(
			new Headers({ "x-lixray-idempotency-principal": account.userId }),
			env.LIXRAY_INTERNAL_TOKEN,
		);
		const upstream = await fetcher(
			new Request(new URL(`/lix/v1/${id}`, service), {
				method: "DELETE",
				headers,
				signal: request.signal,
			}),
		);
		await upstream.body?.cancel();
		if (upstream.status !== 204 && upstream.status !== 404)
			return failure(
				upstream.status >= 400 ? upstream.status : 502,
				"Repository storage could not be deleted. Retry to complete deletion.",
			);
		const registration = await hostedRepositoryRpc(
			env,
			"delete_hosted_lix",
			args,
			fetcher,
		);
		await registration.body?.cancel();
		if (!registration.ok)
			return failure(
				503,
				"Repository deletion is incomplete. Retry to finish.",
			);
		return new Response(null, { status: 204 });
	} catch {
		return failure(
			503,
			"Repository deletion did not complete. Retry to finish.",
		);
	}
}
