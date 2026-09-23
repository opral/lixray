import { createLix } from "@lix-js/sdk";
import type { LixraySupabaseClient } from "./supabase";

const INITIAL_REPOSITORY_NAME = "repo";
// The hosted lifecycle scopes idempotency keys to the authenticated account.
const INITIAL_REPOSITORY_KEY = "lixray:initial-personal-repository";

export interface InitialRepositoryResult {
	path: string | null;
	created: boolean;
}

/** Ensures a browser account's first personal repo exists. */
export async function ensureInitialPersonalRepository(
	client: LixraySupabaseClient,
	accessToken: string,
	origin: string,
	create: typeof createLix = createLix,
): Promise<InitialRepositoryResult> {
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
	const pathFor = (state: typeof initial) =>
		state.repository_id && state.repository_slug
			? `/@${state.namespace_handle}/${state.repository_slug}`
			: null;
	if (!initial.needs_creation)
		return { path: pathFor(initial), created: false };

	try {
		await create({
			server: {
				url: origin,
				headers: {
					authorization: `Bearer ${accessToken}`,
					"x-lixray-namespace-id": namespaceId,
					"x-lixray-repository-name": INITIAL_REPOSITORY_NAME,
					"x-lixray-initial-repository": "1",
				},
			},
			idempotencyKey: INITIAL_REPOSITORY_KEY,
		});
	} catch (error) {
		// Another tab may have finished between the state check and the gateway's
		// name check. In that case, use the repository that won the race.
		const latest = await readState();
		const path = pathFor(latest);
		if (!path) throw error;
		return { path, created: false };
	}
	const latest = await readState();
	const path = pathFor(latest);
	if (!path) {
		throw new Error("The new repository is not available yet. Please retry.");
	}
	return { path, created: true };
}
