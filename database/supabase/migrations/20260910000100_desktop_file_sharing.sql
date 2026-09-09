-- Desktop OAuth uses the same validated resource-bound Lixray account identity.
-- Retain membership and path checks; unrelated-resource grants cannot resolve an account.
create or replace function public.publish_lix_resource(
	p_lix_id uuid, p_path text, p_kind public.lix_publication_kind
)
returns void language plpgsql security definer set search_path to ''
as $$
declare normalized_path text := private.normalize_lix_path(p_path); current_account_id uuid := private.current_account_id();
begin
	if current_account_id is null then raise exception 'Authentication required'; end if;
	if not private.is_lixray_session() then raise exception 'Lixray session required'; end if;
	if not private.can_access_lix(p_lix_id, current_account_id) then raise exception 'Lix access denied'; end if;
	if normalized_path is null then raise exception 'Invalid publication path'; end if;
	insert into public.lix_publications (lix_id, path, kind, published_by_account_id)
	values (p_lix_id, normalized_path, p_kind, current_account_id)
	on conflict (lix_id, path, kind) do update
	set published_by_account_id = excluded.published_by_account_id, created_at = now();
end; $$;

create or replace function public.unpublish_lix_resource(
	p_lix_id uuid, p_path text, p_kind public.lix_publication_kind
)
returns void language plpgsql security definer set search_path to ''
as $$ begin
	if private.current_account_id() is null then raise exception 'Authentication required'; end if;
	if not private.is_lixray_session() then raise exception 'Lixray session required'; end if;
	if not private.can_access_lix(p_lix_id) then raise exception 'Lix access denied'; end if;
	delete from public.lix_publications
	where lix_id = p_lix_id and path = private.normalize_lix_path(p_path) and kind = p_kind;
end; $$;

