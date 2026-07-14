create table public.user_workspace_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  atelier_layout jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id),
  constraint user_workspace_preferences_atelier_layout_v1_check check (
    coalesce(
      jsonb_typeof(atelier_layout) = 'object'
      and atelier_layout -> 'version' = '1'::jsonb
      and atelier_layout - 'version' - 'layout' = '{}'::jsonb
      and jsonb_typeof(atelier_layout -> 'layout') = 'object'
      and (atelier_layout -> 'layout') - 'sizes' = '{}'::jsonb
      and jsonb_typeof(atelier_layout #> '{layout,sizes}') = 'object'
      and (atelier_layout #> '{layout,sizes}') - 'left' - 'central' - 'right' = '{}'::jsonb
      and jsonb_typeof(atelier_layout #> '{layout,sizes,left}') = 'number'
      and jsonb_typeof(atelier_layout #> '{layout,sizes,central}') = 'number'
      and jsonb_typeof(atelier_layout #> '{layout,sizes,right}') = 'number'
      and (atelier_layout #>> '{layout,sizes,left}')::numeric between 0 and 100
      and (atelier_layout #>> '{layout,sizes,central}')::numeric between 0 and 100
      and (atelier_layout #>> '{layout,sizes,right}')::numeric between 0 and 100,
      false
    )
  )
);

create table public.user_workspace_review_resolutions (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  branch_id text not null,
  review_id text not null,
  file_id text not null,
  outcome text not null check (outcome in ('accepted', 'rejected', 'resolved')),
  resolved_at timestamptz not null default now(),
  primary key (user_id, workspace_id, branch_id, review_id, file_id)
);

alter table public.user_workspace_preferences enable row level security;
alter table public.user_workspace_review_resolutions enable row level security;

create policy user_workspace_preferences_owner_member
on public.user_workspace_preferences for all to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and exists (
    select 1
    from public.workspaces workspace
    where workspace.id = user_workspace_preferences.workspace_id
      and workspace.deleted_at is null
      and (select private.is_organization_member(workspace.organization_id))
  )
)
with check (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and exists (
    select 1
    from public.workspaces workspace
    where workspace.id = user_workspace_preferences.workspace_id
      and workspace.deleted_at is null
      and (select private.is_organization_member(workspace.organization_id))
  )
);

create policy user_workspace_review_resolutions_owner_member
on public.user_workspace_review_resolutions for all to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and exists (
    select 1
    from public.workspaces workspace
    where workspace.id = user_workspace_review_resolutions.workspace_id
      and workspace.deleted_at is null
      and (select private.is_organization_member(workspace.organization_id))
  )
)
with check (
  user_id = (select auth.uid())
  and (select private.is_interactive_session())
  and exists (
    select 1
    from public.workspaces workspace
    where workspace.id = user_workspace_review_resolutions.workspace_id
      and workspace.deleted_at is null
      and (select private.is_organization_member(workspace.organization_id))
  )
);

grant select, insert, update, delete on public.user_workspace_preferences to authenticated;
grant select, insert, update, delete on public.user_workspace_review_resolutions to authenticated;
