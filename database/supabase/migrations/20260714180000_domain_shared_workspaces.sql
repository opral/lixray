alter table public.organizations
add column email_domain text;

alter table public.organizations
add constraint organizations_email_domain_normalized check (
  email_domain is null
  or (
    email_domain = lower(btrim(email_domain))
    and char_length(email_domain) between 3 and 253
    and email_domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  )
);

alter table public.organizations
add constraint organizations_automatic_identity_exclusive check (
  personal_owner_id is null or email_domain is null
);

create unique index organizations_email_domain_unique
  on public.organizations(email_domain)
  where email_domain is not null;

create or replace function private.email_domain(source_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(source_email, '')))
      ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    then split_part(lower(btrim(source_email)), '@', 2)
    else null
  end;
$$;

create or replace function private.is_generic_email_domain(target_domain text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(target_domain, ''))) = any (array[
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'hotmail.co.uk',
    'live.com',
    'live.co.uk',
    'msn.com',
    'yahoo.com',
    'yahoo.co.uk',
    'yahoo.ca',
    'yahoo.de',
    'yahoo.fr',
    'yahoo.co.jp',
    'ymail.com',
    'rocketmail.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'aol.com',
    'proton.me',
    'protonmail.com',
    'pm.me',
    'gmx.com',
    'gmx.net',
    'gmx.de',
    'mail.com',
    'email.com',
    'zoho.com',
    'fastmail.com',
    'fastmail.fm',
    'hey.com',
    'tuta.com',
    'tutanota.com',
    'tutamail.com',
    'yandex.com',
    'yandex.ru',
    'mail.ru',
    'inbox.ru',
    'list.ru',
    'bk.ru',
    'qq.com',
    '163.com',
    '126.com',
    'yeah.net',
    'naver.com',
    'daum.net',
    'hanmail.net',
    'web.de',
    'freenet.de',
    't-online.de',
    'orange.fr',
    'wanadoo.fr',
    'laposte.net',
    'libero.it',
    'virgilio.it',
    'seznam.cz',
    'centrum.cz',
    'rediffmail.com',
    'comcast.net',
    'xfinity.com',
    'verizon.net',
    'att.net',
    'sbcglobal.net',
    'bellsouth.net',
    'cox.net',
    'btinternet.com',
    'sky.com',
    'talktalk.net',
    'virginmedia.com',
    'shaw.ca',
    'rogers.com',
    'telus.net',
    'bigpond.com',
    'optusnet.com.au',
    'mailbox.org',
    'posteo.de',
    'example.com',
    'example.org',
    'example.net'
  ]::text[]);
$$;

create or replace function private.domain_workspace_name(target_domain text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  labels text[] := string_to_array(lower(btrim(coalesce(target_domain, ''))), '.');
  label_count integer := coalesce(array_length(labels, 1), 0);
  candidate text;
begin
  if label_count < 2 then
    return coalesce(nullif(private.url_segment(target_domain, 80), ''), 'workspace');
  end if;

  if label_count >= 3
    and char_length(labels[label_count]) = 2
    and labels[label_count - 1] = any (
      array['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']::text[]
    ) then
    candidate := labels[label_count - 2];
  else
    candidate := labels[label_count - 1];
  end if;

  return coalesce(nullif(private.url_segment(candidate, 80), ''), 'workspace');
end;
$$;

revoke all on function private.email_domain(text) from public;
revoke all on function private.is_generic_email_domain(text) from public;
revoke all on function private.domain_workspace_name(text) from public;

create or replace function public.ensure_personal_workspace()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  profile_record public.profiles%rowtype;
  current_email_domain text;
  domain_name text;
  base_handle text;
  candidate_handle text;
  target_organization_id uuid;
  created_workspace boolean := false;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('personal-workspace:' || current_user_id::text, 0)
  );

  select * into profile_record
  from public.profiles
  where id = current_user_id;

  if profile_record.id is null then
    raise exception 'Profile not found';
  end if;

  current_email_domain := private.email_domain(profile_record.email);

  if current_email_domain is not null
    and not private.is_generic_email_domain(current_email_domain) then
    domain_name := private.domain_workspace_name(current_email_domain);

    perform pg_advisory_xact_lock(
      hashtextextended('domain-workspace:' || current_email_domain, 0)
    );

    select id into target_organization_id
    from public.organizations
    where email_domain = current_email_domain;

    if target_organization_id is null then
      insert into public.organizations (name, email_domain)
      values (domain_name, current_email_domain)
      returning id into target_organization_id;

      insert into public.organization_members (organization_id, user_id, role)
      values (target_organization_id, current_user_id, 'owner');
    else
      insert into public.organization_members (organization_id, user_id, role)
      values (target_organization_id, current_user_id, 'member')
      on conflict (organization_id, user_id) do nothing;
    end if;

    if not exists (
      select 1 from public.workspaces
      where organization_id = target_organization_id and deleted_at is null
    ) then
      insert into public.workspaces (organization_id, name)
      values (target_organization_id, domain_name);
      created_workspace := true;
    end if;

    return created_workspace;
  end if;

  select id into target_organization_id
  from public.organizations
  where personal_owner_id = current_user_id;

  if target_organization_id is null then
    base_handle := coalesce(
      nullif(private.url_segment(split_part(profile_record.email, '@', 1), 39), ''),
      nullif(private.url_segment(profile_record.name, 39), ''),
      'user'
    );
    candidate_handle := base_handle;

    perform pg_advisory_xact_lock(
      hashtextextended('organization-handle:' || replace(base_handle, '-', ''), 0)
    );

    if exists (
      select 1 from public.organizations
      where replace(handle, '-', '') = replace(candidate_handle, '-', '')
    ) then
      candidate_handle := left(base_handle, 26) || '-' ||
        left(replace(current_user_id::text, '-', ''), 12);
    end if;

    insert into public.organizations (name, handle, personal_owner_id)
    values (profile_record.name, candidate_handle, current_user_id)
    returning id into target_organization_id;

    insert into public.organization_members (organization_id, user_id, role)
    values (target_organization_id, current_user_id, 'owner');
  end if;

  if not exists (
    select 1 from public.workspaces
    where organization_id = target_organization_id and deleted_at is null
  ) then
    insert into public.workspaces (organization_id, name)
    values (target_organization_id, 'My workspace');
    created_workspace := true;
  end if;

  return created_workspace;
end;
$$;
