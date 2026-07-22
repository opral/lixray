drop function if exists public.accept_organization_invitation(text);
drop function if exists public.revoke_organization_invitation(uuid);
drop function if exists public.create_organization_invitation(uuid, text);

drop table if exists public.organization_invitations;
