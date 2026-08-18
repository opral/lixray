#!/usr/bin/env bash
# Repository bootstrap for LixRay Cloud Agents. Runs after the source tree is
# checked out. Must be idempotent and terminate; per-boot service startup lives
# in start.sh and the dev terminal.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# The vendored Lix and Atelier submodules are required by pnpm install (the
# postinstall builds the Lix WASM SDK) and by the lix-server image build.
git submodule update --init --recursive

# System dependencies missing from the base image:
#   - mold: linker required by the vendored Lix Rust/WASM build (.cargo/config)
#   - fuse-overlayfs: storage driver for nested Docker in the Cloud Agent VM
#   - docker: local Supabase stack and the Compose topology (MinIO + lix-server)
if ! command -v docker >/dev/null 2>&1; then
	sudo install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
		sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
	sudo chmod a+r /etc/apt/keyrings/docker.gpg
	printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
		"$(dpkg --print-architecture)" "$(. /etc/os-release && echo "$VERSION_CODENAME")" |
		sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
fi

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
	-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
	mold fuse-overlayfs \
	docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Nested Docker needs the legacy iptables backend and a userspace storage
# driver; the default overlay2 driver is unavailable inside the VM.
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
echo '{ "storage-driver": "fuse-overlayfs" }' | sudo tee /etc/docker/daemon.json >/dev/null
sudo groupadd -f docker
sudo usermod -aG docker "$(id -un)"

# Node/pnpm workspace dependencies. The root postinstall compiles the vendored
# Lix WASM SDK with the nightly toolchain pinned by vendor/lix/rust-toolchain.toml
# (rustup fetches it automatically).
pnpm install --frozen-lockfile

# Warm Docker so future boots are fast instead of rebuilding from scratch. The
# vendored Rust server image is the dominant cost; the Supabase and MinIO images
# are large pulls. All artifacts persist on the snapshotted disk.
bash "$repo_root/.cursor/start-docker.sh"
docker compose build lix-server
docker compose pull minio
pnpm --dir database exec supabase start
pnpm --dir database exec supabase stop

# Only the pre-built/pre-pulled images should carry into the snapshot, never
# application containers. A reused lix-server container keeps a populated
# slatedb cache whose restart cleanup fails under fuse-overlayfs (EXDEV), so the
# first `pnpm dev` must be able to create fresh containers. Remove any that a
# base snapshot may have left behind (images and volumes are preserved).
docker compose down --remove-orphans

echo "LixRay install complete."
