-- Both ordinary and initial registrations take the same account lock before
-- inserting a personal repo. The marker is therefore visible to whichever
-- registration starts second, even when the names differ.
create function private.lock_personal_repository_account()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  perform 1 from public.accounts account
  where account.primary_namespace_id = new.namespace_id for update;
  return new;
end;
$$;
create trigger lixes_lock_personal_repository_account
before insert on public.lixes
for each row execute function private.lock_personal_repository_account();
