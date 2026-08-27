#!/bin/sh
set -eu

value="${1-}"
if ! printf '%s\n' "$value" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  echo "Lix ID must be a canonical lowercase UUID" >&2
  exit 2
fi
