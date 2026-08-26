create table public.namespace_profiles (
  namespace_id uuid primary key
    references public.namespaces(id)
    on delete cascade,
  document jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint namespace_profiles_document_is_jscontact_v2_card check (
    jsonb_typeof(document) = 'object'
    and document ->> '@type' = 'Card'
    and document ->> 'version' = '2.0'
  )
);

comment on table public.namespace_profiles is
  'Public JSContact 2.0 profiles for stable LixRay namespace identities.';
comment on column public.namespace_profiles.namespace_id is
  'Immutable public namespace identity. Handles are mutable aliases for this ID.';
comment on column public.namespace_profiles.document is
  'Public JSContact 2.0 Card returned by GET /profile/{namespace_id}. Never store private authentication data here.';

create trigger namespace_profiles_set_updated_at
before update on public.namespace_profiles
for each row execute function private.set_updated_at();

alter table public.namespace_profiles enable row level security;

create policy namespace_profiles_select_public
on public.namespace_profiles
for select
to anon, authenticated
using (true);

create policy namespace_profiles_write_owner
on public.namespace_profiles
for all
to authenticated
using (
  private.is_interactive_session()
  and private.is_namespace_owner(namespace_id)
)
with check (
  private.is_interactive_session()
  and private.is_namespace_owner(namespace_id)
);

grant select on table public.namespace_profiles to anon;
grant select, insert, update, delete on table public.namespace_profiles to authenticated;
grant all on table public.namespace_profiles to service_role;
