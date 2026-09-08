#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository_root/database"

cleanup() {
	supabase stop --all --no-backup || true
}
trap cleanup EXIT

# Blacksmith runners are isolated, but clean every local Supabase project so a
# differently named or interrupted stack cannot retain the default database
# port. Keep diagnostics close to the failure if a non-Supabase process owns it.
cleanup
if ss -ltnp | grep -q ':54322 '; then
	ss -ltnp | grep ':54322 ' >&2 || true
	docker ps --format '{{.ID}}\t{{.Names}}\t{{.Ports}}' >&2 || true
	echo 'Supabase database port 54322 is still occupied after cleanup.' >&2
	exit 1
fi

supabase start \
	--exclude edge-runtime,imgproxy,kong,logflare,mailpit,postgres-meta,realtime,storage-api,studio,supavisor,vector
supabase test db

# Exercise the real code-exchange/refresh lifecycle, including GoTrue deleting
# its authorization row. The test uses Node built-ins and the pure MCP validator.
node --experimental-strip-types "$repository_root/database/scripts/test-oauth-resource.mjs"
