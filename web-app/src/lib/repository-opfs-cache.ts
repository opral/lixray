export interface RepositoryOpfsCacheIdentity {
	namespace: string;
	repositorySlug: string;
	repositoryId?: string;
	replicaId: string;
}

// Hard-cut this prefix whenever an unshipped sync protocol or durable replica
// layout changes. Reusing the old `lixray:` names would let incompatible OPFS
// rows participate in bootstrap before the new server can repair them.
export const REPOSITORY_OPFS_CACHE_NAMESPACE = "lixray:sync-protocol-v2";

export function repositoryOpfsCacheName(
	identity: RepositoryOpfsCacheIdentity,
): string {
	const repository =
		identity.repositoryId ?? `${identity.namespace}/${identity.repositorySlug}`;
	return `${REPOSITORY_OPFS_CACHE_NAMESPACE}:${repository}:${identity.replicaId}`;
}
