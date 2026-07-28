-- Keep auth.users, OAuth clients, consents, authorizations, refresh tokens,
-- and profiles stable. Deleting namespaces cascades through every piece of
-- product state created by the onboarding flow, including Lixes and recorded
-- MCP-to-Lix handshakes.
delete from public.namespaces;
