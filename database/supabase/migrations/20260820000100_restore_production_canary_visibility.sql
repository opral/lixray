-- The production protocol canary predates repository visibility controls and
-- must remain anonymously readable for the post-deploy handshake/read check.
update public.lixes as lix
set visibility = 'public'::public.lix_visibility
from public.handles as handle
where handle.namespace_id = lix.namespace_id
	and handle.handle = 'dev'
	and lix.slug = 'ci-repo'
	and lix.deleted_at is null;
