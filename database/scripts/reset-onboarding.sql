-- Keep auth users, neutral accounts/login mappings, OAuth clients, consents,
-- authorizations and refresh tokens stable. Personal namespaces are recreated
-- by the idempotent bootstrap on the next interactive request.
update public.accounts set primary_namespace_id = null;
delete from public.namespaces;
