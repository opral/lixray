-- Existing accounts have already passed onboarding, including accounts whose
-- last personal repository was intentionally deleted. Only future accounts
-- receive a personal repository on their first browser sign-in.
alter table public.accounts
  add column initial_repository_provisioned boolean not null default false;
update public.accounts set initial_repository_provisioned = true;

-- Any personal repository created through the regular lifecycle completes
-- onboarding too, even if it was created in another tab before /open loads.
create function private.mark_initial_repository_provisioned()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  update public.accounts account
  set initial_repository_provisioned = true
  where account.primary_namespace_id = new.namespace_id
    and not account.initial_repository_provisioned;
  return new;
end;
$$;
create trigger lixes_mark_initial_repository_provisioned
after insert on public.lixes
for each row execute function private.mark_initial_repository_provisioned();

-- The browser checks this after namespace bootstrap. Return the first personal
-- repo when present so concurrent sign-ins can converge on its stable ID.
create function public.initial_personal_repository_state()
returns table(namespace_id uuid, namespace_handle text, repository_id uuid,
  repository_slug text, needs_creation boolean)
language plpgsql security definer set search_path to '' as $$
declare
  actor_id uuid := private.current_account_id();
  personal_namespace uuid;
  completed boolean;
begin
  if actor_id is null or not private.is_interactive_session() then
    raise exception 'Interactive authentication required' using errcode = '42501';
  end if;
  select account.primary_namespace_id, account.initial_repository_provisioned
  into personal_namespace, completed
  from public.accounts account where account.id = actor_id and account.status = 'active';
  if personal_namespace is null then
    raise exception 'Personal namespace is not ready';
  end if;
  return query
  select personal_namespace, handle.handle, repository.id, repository.slug,
    not completed and repository.id is null
  from public.handles handle
  left join lateral (
    select lix.id, lix.slug from public.lixes lix
    where lix.namespace_id = personal_namespace and lix.deleted_at is null
    order by lix.created_at, lix.id limit 1
  ) repository on true
  where handle.namespace_id = personal_namespace and handle.state = 'active';
end;
$$;
revoke all on function public.initial_personal_repository_state() from public, anon;
grant execute on function public.initial_personal_repository_state() to authenticated;
