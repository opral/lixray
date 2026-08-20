-- User preferences associated with a repository must not use the LixRay
-- control-plane database as their source of truth. This is an intentional hard
-- cut: existing rows are deleted without migration or fallback.
drop table public.user_lix_preferences;
