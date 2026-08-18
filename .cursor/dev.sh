#!/usr/bin/env bash
# LixRay development stack: starts local Supabase, applies migrations, creates
# the local developer account, builds and runs the Compose topology (MinIO +
# lix-server), and serves the web app and MCP endpoint on http://127.0.0.1:8787.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bash "$repo_root/.cursor/start-docker.sh"

# Reach the Docker daemon without sudo even if this login started before the
# docker group membership took effect.
if ! docker info >/dev/null 2>&1; then
	exec sg docker -c "cd '$repo_root' && exec pnpm dev"
fi

exec pnpm dev
