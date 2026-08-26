create function public.list_public_profile_lixes(p_namespace_id uuid)
returns table(
  namespace_id uuid,
  namespace_handle text,
  lix_id uuid,
  lix_name text,
  lix_slug text,
  lix_updated_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
  select
    namespace.id,
    handle.handle,
    lix.id,
    lix.name,
    lix.slug,
    lix.updated_at
  from public.namespaces namespace
  join public.handles handle
    on handle.namespace_id = namespace.id
    and handle.state = 'active'
  join public.lixes lix
    on lix.namespace_id = namespace.id
    and lix.deleted_at is null
    and lix.visibility = 'public'
  join public.namespace_profiles profile
    on profile.namespace_id = namespace.id
  where namespace.id = p_namespace_id
  order by lix.updated_at desc, lix.id;
$$;

revoke all on function public.list_public_profile_lixes(uuid) from public;
grant execute on function public.list_public_profile_lixes(uuid) to anon, authenticated;

comment on function public.list_public_profile_lixes(uuid) is
  'Lists live public repositories owned by a namespace with a public profile. File statistics are resolved from each Lix separately.';
