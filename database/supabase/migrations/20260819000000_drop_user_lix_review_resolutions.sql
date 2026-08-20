-- Review-resolution state is repository-associated state and must not use the
-- LixRay control-plane database as its source of truth. This is an intentional
-- hard cut: existing rows are deleted without migration or fallback.
drop table public.user_lix_review_resolutions;
