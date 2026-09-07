#!/usr/bin/env bash
set -euo pipefail

minimum_gb="${MINIMUM_FREE_GB:-10}"
if ! [[ "$minimum_gb" =~ ^[1-9][0-9]*$ ]]; then
  echo 'MINIMUM_FREE_GB must be a positive integer' >&2
  exit 1
fi
minimum_kb=$((minimum_gb * 1024 * 1024))
workspace="${GITHUB_WORKSPACE:-.}"

enough_space() {
  local available mount_path
  for mount_path in "$workspace" /var/lib/docker; do
    test -e "$mount_path" || continue
    available="$(df -Pk "$mount_path" | awk 'NR == 2 { print $4 }')"
    [[ "$available" =~ ^[0-9]+$ ]] || return 1
    if (( available < minimum_kb )); then
      echo "$mount_path has $available KiB free; need $minimum_kb KiB."
      return 1
    fi
  done
  return 0
}

if enough_space; then
  echo "At least $minimum_gb GiB free; skipping disk cleanup."
  exit 0
fi

# Only remove unused SDKs, stopping as soon as the build has enough room.
for sdk_path in /usr/local/lib/android /usr/share/dotnet /usr/share/swift /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL; do
  sudo rm -rf "$sdk_path"
  if enough_space; then
    echo "Recovered enough space after removing $sdk_path."
    exit 0
  fi
done
sudo apt-get clean
df -h "$workspace"
if ! enough_space; then
  echo "Could not free $minimum_gb GiB for the build." >&2
  exit 1
fi
