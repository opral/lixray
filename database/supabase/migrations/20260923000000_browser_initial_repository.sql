-- Existing personal namespaces have already passed onboarding, including
-- accounts whose last repository was intentionally deleted. Older accounts
-- without a personal namespace can still complete browser onboarding.
alter table public.accounts
  add column initial_repository_provisioned boolean not null default false;
update public.accounts set initial_repository_provisioned = true
where primary_namespace_id is not null;

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

-- A different named personal repo can be created while the browser is
-- uploading its initial empty repo. Serialize registration against the account
-- marker so that this race never publishes a second repository.
create function public.register_initial_hosted_lix(
  p_lix_id uuid, p_account_id uuid, p_namespace_id uuid, p_name text)
returns void language plpgsql security definer set search_path to '' as $$
declare
  personal_namespace uuid;
  completed boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Gateway authentication required';
  end if;
  select account.primary_namespace_id, account.initial_repository_provisioned
  into personal_namespace, completed
  from public.accounts account
  where account.id = p_account_id and account.status = 'active'
  for update;
  if personal_namespace is null or personal_namespace <> p_namespace_id then
    raise exception 'Personal namespace required' using errcode = '42501';
  end if;
  if completed and not exists (
    select 1 from private.hosted_lix_creations receipt
    where receipt.lix_id = p_lix_id and receipt.account_id = p_account_id
  ) then
    raise exception 'A personal repository already exists' using errcode = '23505';
  end if;
  perform public.register_hosted_lix(p_lix_id, p_account_id, p_namespace_id, p_name);
end;
$$;
revoke all on function public.register_initial_hosted_lix(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.register_initial_hosted_lix(uuid,uuid,uuid,text)
  to service_role;
