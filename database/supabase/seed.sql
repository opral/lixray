-- Local-only resource policy. Hosted production migrations do not run this seed.
insert into private.oauth_resource_policy(resource) values
 ('http://127.0.0.1:8787'), ('http://localhost:8787')
on conflict do nothing;
