-- Public entity resolution runs on the trusted gateway: it resolves identity
-- before checking the live publication path. BYPASSRLS does not grant SELECT.
-- Declare these reads explicitly, including on fresh installs where the initial
-- schema's later ALTER DEFAULT PRIVILEGES does not affect existing tables.
grant select on table public.handles, public.lixes to service_role;
