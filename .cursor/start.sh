#!/usr/bin/env bash
# Per-boot startup. Brings the Docker daemon online; application services are
# started by the "dev" terminal (pnpm dev).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$repo_root/.cursor/start-docker.sh"
