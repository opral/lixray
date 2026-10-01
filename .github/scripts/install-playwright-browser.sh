#!/usr/bin/env bash
set -euo pipefail

# The Azure Ubuntu mirror stalled CI at 31 kB/s and exhausted a browser job's
# budget. Use the standard mirror for the same signed Ubuntu package sources.
for apt_source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  if [[ -f "$apt_source" ]]; then
    sudo sed -i 's|azure.archive.ubuntu.com/ubuntu|archive.ubuntu.com/ubuntu|g' "$apt_source"
  fi
done

pnpm --dir web-app exec playwright install --with-deps chromium
