import type { WorkerEnv } from "./handler.ts";
import { lixServiceRequestHeaders } from "../lib/lix-service-proxy.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = (status: number, message: string) =>
	Response.json(
		{ error: { code: "LIX_HOST_CREATION_FAILED", message } },
		{ status },
	);

/** The reference server owns snapshot validation and durable, account-scoped retries. */
export async function createHostedRepository(
	request: Request,
	env: WorkerEnv,
	account: { userId: string; token: string },
	fetcher: typeof fetch = fetch,
): Promise<Response> {
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
		return failure(503, "Repository creation is not configured.");
	const key = request.headers.get("idempotency-key");
	if (!key || !/^[\x21-\x7e]{1,255}$/.test(key))
		return failure(400, "A valid Idempotency-Key is required.");
	const type = request.headers.get("content-type");
	if (type && type !== "application/vnd.lix.snapshot")
		return failure(415, "Expected application/vnd.lix.snapshot.");
	try {
		// The account must already have completed Lixray onboarding. OAuth grants
		// cannot impersonate browser-only namespace bootstrapping.
		const owner = await fetcher(
			new URL(
				`/rest/v1/accounts?id=eq.${encodeURIComponent(account.userId)}&status=eq.active&select=primary_namespace_id`,
				env.SUPABASE_URL,
			),
			{
				headers: {
					apikey: env.SUPABASE_SERVICE_ROLE_KEY,
					authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
				},
			},
		);
		if (!owner.ok) {
			await owner.body?.cancel();
			return failure(503, "Account information is unavailable.");
		}
		const owners = JSON.parse(await readDescriptor(owner)) as Array<{
			primary_namespace_id?: string;
		}>;
		if (!owners[0]?.primary_namespace_id)
			return failure(
				403,
				"Finish setting up your personal account on Lixray before sharing.",
			);

		// Allowlist headers: never trust client-supplied protocol principal or scope.
		const headers = lixServiceRequestHeaders(
			new Headers({
				"idempotency-key": key,
				"x-lixray-idempotency-principal": account.userId,
				...(type ? { "content-type": type } : {}),
			}),
			env.LIXRAY_INTERNAL_TOKEN,
		);
		const upstream = await fetcher(
			new Request(new URL("/lix/v1", service), {
				method: "POST",
				headers,
				body: request.body,
				// Node requires duplex for streaming request bodies.
				...({ duplex: "half" } as Record<string, string>),
			}),
		);
		const body = await readDescriptor(upstream);
		if (upstream.status !== 201)
			return new Response(body, {
				status: upstream.status >= 400 ? upstream.status : 502,
				headers: { "content-type": "application/json" },
			});
		const descriptor: unknown = JSON.parse(body);
		const id =
			descriptor && typeof descriptor === "object" && "id" in descriptor
				? descriptor.id
				: null;
		if (typeof id !== "string" || !UUID.test(id))
			return failure(
				502,
				"The server returned an invalid repository descriptor.",
			);

		// This RPC is service-role-only. A browser must never be able to claim an
		// arbitrary existing server ID. It atomically records the receipt and owner.
		const registration = await fetcher(
			new URL("/rest/v1/rpc/register_hosted_lix", env.SUPABASE_URL),
			{
				method: "POST",
				headers: {
					apikey: env.SUPABASE_SERVICE_ROLE_KEY,
					authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ p_lix_id: id, p_account_id: account.userId }),
			},
		);
		await registration.body?.cancel();
		if (!registration.ok)
			return failure(
				503,
				"Ownership registration is incomplete. Retry with the same Idempotency-Key and snapshot.",
			);
		const url = new URL(`/lix/${id}`, request.url).href;
		return Response.json(
			{ id, url },
			{ status: 201, headers: { location: url, "cache-control": "no-store" } },
		);
	} catch {
		return failure(
			503,
			"Repository creation did not complete. Retry with the same Idempotency-Key and snapshot.",
		);
	}
}

async function readDescriptor(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing lifecycle response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 64 * 1024) throw new Error("Lifecycle response exceeds limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
