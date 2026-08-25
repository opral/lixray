-- Public presentation data belongs to the namespace's JSContact document.
-- The private auth profile keeps only onboarding/account data.

insert into public.namespace_profiles (namespace_id, document)
select
  primary_namespace.namespace_id,
  jsonb_strip_nulls(jsonb_build_object(
    '@type', 'Card',
    'version', '2.0',
    'kind', 'individual',
    'name', jsonb_build_object('full', profile.name),
    'media', case
      when nullif(btrim(profile.avatar_url), '') is null then null
      else jsonb_build_object(
        'avatar', jsonb_build_object(
          '@type', 'Media',
          'kind', 'photo',
          'uri', btrim(profile.avatar_url)
        )
      )
    end
  ))
from public.user_primary_namespaces primary_namespace
join public.profiles profile on profile.id = primary_namespace.user_id
on conflict (namespace_id) do nothing;

create or replace function private.sync_auth_user_profile() returns trigger
language plpgsql security definer
set search_path to ''
as $$
declare
  profile_name text;
begin
  profile_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'User'
  );

  insert into public.profiles (id, email, name)
  values (
    new.id,
    lower(btrim(coalesce(new.email, ''))),
    left(profile_name, 80)
  )
  on conflict (id) do update
  set email = excluded.email,
    name = excluded.name;

  return new;
end;
$$;

create or replace function public.bootstrap_personal_namespace()
returns table(
  namespace_id uuid,
  namespace_name text,
  namespace_handle text,
  lix_id uuid,
  lix_name text,
  lix_slug text,
  created boolean
)
language plpgsql security definer
set search_path to ''
as $$
declare
  current_user_id uuid := auth.uid();
  profile_record public.profiles%rowtype;
  auth_metadata jsonb;
  avatar_uri text;
  profile_document jsonb;
  existing_namespace_id uuid;
  created_namespace_id uuid;
  created_lix_id uuid;
  claimed_handle text;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;

  select * into profile_record from public.profiles where id = current_user_id;
  if profile_record.id is null then raise exception 'Profile not found'; end if;
  select raw_user_meta_data into auth_metadata
  from auth.users
  where id = current_user_id;

  avatar_uri := coalesce(
    nullif(btrim(auth_metadata ->> 'avatar_url'), ''),
    nullif(btrim(auth_metadata ->> 'picture'), '')
  );
  profile_document := jsonb_build_object(
    '@type', 'Card',
    'version', '2.0',
    'kind', 'individual',
    'name', jsonb_build_object('full', profile_record.name)
  );
  if avatar_uri is not null then
    profile_document := profile_document || jsonb_build_object(
      'media', jsonb_build_object(
        'avatar', jsonb_build_object(
          '@type', 'Media',
          'kind', 'photo',
          'uri', avatar_uri
        )
      )
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended('personal-namespace:' || current_user_id::text, 0));
  select primary_namespace.namespace_id into existing_namespace_id
  from public.user_primary_namespaces primary_namespace
  where primary_namespace.user_id = current_user_id;

  if existing_namespace_id is not null then
    insert into public.namespace_profiles (namespace_id, document)
    values (existing_namespace_id, profile_document)
    on conflict on constraint namespace_profiles_pkey do nothing;

    return query
    select namespace.id, namespace.name, handle.handle,
      lix.id, lix.name, lix.slug, false
    from public.namespaces namespace
    join public.handles handle
      on handle.namespace_id = namespace.id and handle.state = 'active'
    left join lateral (
      select candidate.id, candidate.name, candidate.slug
      from public.lixes candidate
      where candidate.namespace_id = namespace.id and candidate.deleted_at is null
      order by candidate.created_at asc
      limit 1
    ) lix on true
    where namespace.id = existing_namespace_id;
    return;
  end if;

  claimed_handle := private.unique_handle(
    coalesce(nullif(split_part(profile_record.email, '@', 1), ''), profile_record.name),
    current_user_id
  );
  perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));

  insert into public.namespaces (name)
  values (profile_record.name)
  returning id into created_namespace_id;
  insert into public.namespace_members (namespace_id, user_id, role)
  values (created_namespace_id, current_user_id, 'owner');
  insert into public.user_primary_namespaces (user_id, namespace_id)
  values (current_user_id, created_namespace_id);
  insert into public.handles (handle, namespace_id)
  values (claimed_handle, created_namespace_id);
  insert into public.namespace_profiles (namespace_id, document)
  values (created_namespace_id, profile_document);
  insert into public.lixes (namespace_id, name, slug)
  values (created_namespace_id, 'repository', 'repository')
  returning id into created_lix_id;

  return query select created_namespace_id, profile_record.name, claimed_handle,
    created_lix_id, 'repository'::text, 'repository'::text, true;
end;
$$;

drop function public.resolve_lix_share_token(text);
create function public.resolve_lix_share_token(p_token text)
returns table(
  namespace_id uuid,
  namespace_name text,
  namespace_handle text,
  lix_id uuid,
  lix_name text,
  lix_slug text,
  shared_by_name text,
  shared_by_avatar_url text,
  can_edit boolean,
  role public.lix_role,
  visibility public.lix_visibility,
  path_public boolean
)
language sql stable security definer
set search_path to ''
as $$
  with capability as (
    select token.lix_id, token.shared_by
    from public.lix_share_tokens token
    where token.token_hash = encode(
      extensions.digest(coalesce(p_token, ''), 'sha256'),
      'hex'
    )
      and token.revoked_at is null
      and token.can_edit
    union all
    select link.lix_id, link.created_by
    from public.lix_invite_links link
    where link.token = coalesce(p_token, '')
    limit 1
  )
  select namespace.id, namespace.name, handle.handle,
    lix.id, lix.name, lix.slug,
    coalesce(namespace_profile.document #>> '{name,full}', auth_profile.name),
    namespace_profile.document #>> '{media,avatar,uri}',
    true, member.role, lix.visibility, (lix.visibility = 'public')
  from capability
  join public.lixes lix on lix.id = capability.lix_id
  join public.namespaces namespace on namespace.id = lix.namespace_id
  join public.handles handle
    on handle.namespace_id = namespace.id and handle.state = 'active'
  left join public.profiles auth_profile on auth_profile.id = capability.shared_by
  left join public.user_primary_namespaces primary_namespace
    on primary_namespace.user_id = capability.shared_by
  left join public.namespace_profiles namespace_profile
    on namespace_profile.namespace_id = primary_namespace.namespace_id
  left join public.lix_members member
    on member.lix_id = lix.id and member.user_id = auth.uid()
  where lix.deleted_at is null;
$$;

revoke all on function public.resolve_lix_share_token(text) from public;
grant all on function public.resolve_lix_share_token(text) to anon, authenticated;

create or replace function public.list_namespace_members(p_namespace_id uuid)
returns table(
  user_id uuid,
  name text,
  email text,
  avatar_url text,
  role public.namespace_role,
  joined_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
  select member.user_id,
    coalesce(namespace_profile.document #>> '{name,full}', auth_profile.name),
    auth_profile.email,
    namespace_profile.document #>> '{media,avatar,uri}',
    member.role, member.created_at
  from public.namespace_members member
  join public.profiles auth_profile on auth_profile.id = member.user_id
  left join public.user_primary_namespaces primary_namespace
    on primary_namespace.user_id = member.user_id
  left join public.namespace_profiles namespace_profile
    on namespace_profile.namespace_id = primary_namespace.namespace_id
  where member.namespace_id = p_namespace_id
    and private.is_interactive_session()
    and private.is_namespace_member(p_namespace_id, auth.uid())
  order by member.created_at asc, auth_profile.name asc;
$$;

create or replace function public.list_lix_members(p_lix_id uuid)
returns table(
  user_id uuid,
  name text,
  email text,
  avatar_url text,
  role public.lix_role,
  joined_at timestamptz
)
language sql stable security definer
set search_path to ''
as $$
  select member.user_id,
    coalesce(namespace_profile.document #>> '{name,full}', auth_profile.name),
    auth_profile.email,
    namespace_profile.document #>> '{media,avatar,uri}',
    member.role, member.created_at
  from public.lix_members member
  join public.profiles auth_profile on auth_profile.id = member.user_id
  left join public.user_primary_namespaces primary_namespace
    on primary_namespace.user_id = member.user_id
  left join public.namespace_profiles namespace_profile
    on namespace_profile.namespace_id = primary_namespace.namespace_id
  where member.lix_id = p_lix_id
    and private.is_interactive_session()
    and private.can_access_lix(p_lix_id, auth.uid())
  order by case member.role when 'admin' then 0 else 1 end,
    member.created_at, auth_profile.name;
$$;

alter table public.profiles drop column avatar_url;

comment on table public.profiles is
  'Private auth-side account data used for onboarding. Public presentation data lives in namespace_profiles.document.';
