create or replace function public.resolve_public_profile_by_handle(p_handle text)
returns table(
  namespace_id uuid,
  namespace_handle text,
  namespace_created_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
  select namespace.id, canonical_handle.handle, namespace.created_at
  from public.handles requested_handle
  join public.namespaces namespace on namespace.id = requested_handle.namespace_id
  join public.handles canonical_handle
    on canonical_handle.namespace_id = namespace.id
    and canonical_handle.state = 'active'
  join public.namespace_profiles profile on profile.namespace_id = namespace.id
  where requested_handle.handle = lower(btrim(coalesce(p_handle, '')))
    and requested_handle.state in ('active', 'redirect')
    and lower(btrim(coalesce(p_handle, '')))
      ~ '^[a-z0-9](?:-?[a-z0-9]){0,38}$'
  limit 1;
$$;

comment on function public.resolve_public_profile_by_handle(text) is
  'Resolves a mutable public handle to its stable namespace profile identity. The JSContact document is served separately by GET /profile/{namespace_id}.';

revoke all on function public.resolve_public_profile_by_handle(text) from public;
grant execute on function public.resolve_public_profile_by_handle(text) to anon, authenticated;
