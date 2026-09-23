import { createLix } from "@lix-js/sdk";
import type { LixraySupabaseClient } from "./supabase";

const INITIAL_REPOSITORY_NAME = "repo";
// The hosted lifecycle scopes idempotency keys to the authenticated account.
const INITIAL_REPOSITORY_KEY = "lixray:initial-personal-repository";

/** Returns a path only when this call had to provision the initial repository. */
export async function ensureInitialPersonalRepository(
	client: LixraySupabaseClient,
	accessToken: string,
	origin: string,
	create: typeof createLix = createLix,
): Promise<string | null> {
	const bootstrap = await client.rpc("bootstrap_personal_namespace");
	if (bootstrap.error) throw bootstrap.error;
	const namespaceId = bootstrap.data?.[0]?.namespace_id;
	if (!namespaceId) throw new Error("Personal namespace is unavailable.");

	const readState = async () => {
		const response = await client.rpc("initial_personal_repository_state");
		if (response.error) throw response.error;
		const state = response.data?.[0];
		if (!state || state.namespace_id !== namespaceId) {
			throw new Error("Personal repository state is unavailable.");
		}
		return state;
	};
	const initial = await readState();
	if (!initial.needs_creation) return null;

	try {
		await create({
			server: {
				url: origin,
				headers: {
					authorization: `Bearer ${accessToken}`,
					"x-lixray-namespace-id": namespaceId,
					"x-lixray-repository-name": INITIAL_REPOSITORY_NAME,
				},
			},
			idempotencyKey: INITIAL_REPOSITORY_KEY,
		});
	} catch (error) {
		// Another tab may have finished between the state check and the gateway's
		// name check. In that case, use the repository that won the race.
		const latest = await readState();
		if (!latest.repository_id) throw error;
		return `/@${latest.namespace_handle}/${latest.repository_slug}`;
	}
	const latest = await readState();
	if (!latest.repository_id || !latest.repository_slug) {
		throw new Error("The new repository is not available yet. Please retry.");
	}
	return `/@${latest.namespace_handle}/${latest.repository_slug}`;
}
