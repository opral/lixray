-- Every namespace is public by default: organizations get a namespace_profiles
-- row (and thus a public profile page) just like personal namespaces.

insert into public.namespace_profiles (namespace_id, document)
select
  namespace.id,
  jsonb_build_object(
    '@type', 'Card',
    'version', '2.0',
    'kind', case
      when primary_namespace.namespace_id is null then 'org'
      else 'individual'
    end,
    'name', jsonb_build_object('full', namespace.name)
  )
from public.namespaces namespace
left join public.user_primary_namespaces primary_namespace
  on primary_namespace.namespace_id = namespace.id
on conflict on constraint namespace_profiles_pkey do nothing;

create or replace function public.create_namespace(p_name text)
returns uuid
language plpgsql security definer
set search_path to ''
as $$
declare
	current_user_id uuid := auth.uid();
	normalized_name text := btrim(coalesce(p_name, ''));
	new_namespace_id uuid;
	claimed_handle text;
begin
	if current_user_id is null then raise exception 'Authentication required'; end if;
	if not private.is_interactive_session() then raise exception 'Interactive session required'; end if;
	if char_length(normalized_name) not between 1 and 80 then
		raise exception 'Organization name must be between 1 and 80 characters';
	end if;
	claimed_handle := private.unique_handle(normalized_name, current_user_id);
	perform pg_advisory_xact_lock(hashtextextended('handle:' || replace(claimed_handle, '-', ''), 0));
	insert into public.namespaces (name)
	values (normalized_name)
	returning id into new_namespace_id;
	insert into public.namespace_members (namespace_id, user_id, role)
	values (new_namespace_id, current_user_id, 'owner');
	insert into public.handles (handle, namespace_id)
	values (claimed_handle, new_namespace_id);
	insert into public.namespace_profiles (namespace_id, document)
	values (new_namespace_id, jsonb_build_object(
		'@type', 'Card',
		'version', '2.0',
		'kind', 'org',
		'name', jsonb_build_object('full', normalized_name)
	));
	return new_namespace_id;
end;
$$;
