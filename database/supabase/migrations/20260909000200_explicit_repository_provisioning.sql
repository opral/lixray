-- Old control-plane rows may own durable data. Opening them must never initialize
-- an empty replacement when backing storage is temporarily missing.
alter table public.lixes add column storage_provision_mode text not null
 default 'adopt-existing' check (storage_provision_mode in ('create-new','adopt-existing'));
alter table public.lixes alter column storage_provision_mode set default 'create-new';

create function private.guard_lix_storage_provision_mode() returns trigger
language plpgsql set search_path to '' as $$
begin
 if TG_OP = 'UPDATE' and new.storage_provision_mode is distinct from old.storage_provision_mode then
  raise exception 'Repository provisioning mode is immutable';
 end if;
 if TG_OP = 'INSERT' and new.storage_provision_mode <> 'create-new' then
  raise exception 'New repositories must use explicit creation';
 end if;
 return new;
end;
$$;
create trigger guard_lix_storage_provision_mode before insert or update on public.lixes
 for each row execute function private.guard_lix_storage_provision_mode();

-- Resolve only after a current repository membership check. PATs are credentials,
-- not Supabase JWTs; keep their verification in the existing authorization RPC.
create function public.resolve_lix_provision_mode(p_lix_id uuid,p_api_token text default null)
returns table(storage_provision_mode text)
language sql stable security definer set search_path to '' as $$
 select l.storage_provision_mode from public.lixes l
 where l.id=p_lix_id and l.deleted_at is null and (
  private.can_access_lix_or_unseeded(l.id,l.namespace_id,private.current_account_id())
  or exists(select 1 from public.authorize_api_token(p_api_token,p_lix_id) a where a.allowed)
 );
$$;
revoke all on function public.resolve_lix_provision_mode(uuid,text) from public;
grant execute on function public.resolve_lix_provision_mode(uuid,text) to anon,authenticated;
