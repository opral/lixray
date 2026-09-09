-- A receipt distinguishes a retry from an attempt to claim an unrelated ID.
create table private.hosted_lix_creations (
 lix_id uuid primary key,
 account_id uuid not null references public.accounts(id),
 created_at timestamptz not null default now()
);
revoke all on private.hosted_lix_creations from public, anon, authenticated;

create or replace function private.guard_lix_storage_provision_mode() returns trigger
language plpgsql set search_path to '' as $$
begin
 if TG_OP = 'UPDATE' and new.storage_provision_mode is distinct from old.storage_provision_mode then
  raise exception 'Repository provisioning mode is immutable';
 end if;
 if TG_OP = 'INSERT' and new.storage_provision_mode <> 'create-new'
    and coalesce(auth.role(), '') <> 'service_role' then
  raise exception 'New repositories must use explicit creation';
 end if;
 return new;
end;
$$;

-- Only the authenticated gateway may submit a successful reference-server receipt.
-- The caller's JWT is never allowed to select or claim a server repository ID.
create function public.register_hosted_lix(p_lix_id uuid, p_account_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare
 owner_namespace uuid;
 recorded_account uuid;
 existing_repository public.lixes%rowtype;
begin
 if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Gateway authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hosted-lix:' || p_lix_id::text, 0));
 select account.primary_namespace_id into owner_namespace
 from public.accounts account where account.id = p_account_id;
 if owner_namespace is null then raise exception 'Personal namespace required'; end if;
 select receipt.account_id into recorded_account from private.hosted_lix_creations receipt where receipt.lix_id = p_lix_id;
 select * into existing_repository from public.lixes where id = p_lix_id;
 if recorded_account is not null then
  if recorded_account <> p_account_id or existing_repository.id is null or existing_repository.deleted_at is not null then
   raise exception 'Repository creation receipt is no longer available';
  end if;
  -- Do not reset subsequent publication, name, permissions, or namespace changes.
  return;
 end if;
 if existing_repository.id is not null then raise exception 'Repository ID already registered'; end if;
 insert into public.lixes(id, namespace_id, name, slug, visibility, storage_provision_mode)
 values (p_lix_id, owner_namespace, 'Shared repository', 'shared-' || p_lix_id::text, 'private', 'adopt-existing');
 insert into private.hosted_lix_creations(lix_id, account_id) values (p_lix_id, p_account_id);
end;
$$;
revoke all on function public.register_hosted_lix(uuid,uuid) from public, anon, authenticated;
grant execute on function public.register_hosted_lix(uuid,uuid) to service_role;
