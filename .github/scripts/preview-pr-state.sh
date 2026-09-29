#!/usr/bin/env bash
set -euo pipefail

if [[ ! "${PR_NUMBER:-}" =~ ^[1-9][0-9]*$ ]]; then
  echo "A valid PR_NUMBER is required before preview creation." >&2
  exit 1
fi
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

state="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .state)"
case "$state" in
  open)
    echo "open=true" >> "$GITHUB_OUTPUT"
    ;;
  closed)
    echo "::notice::PR is closed; preview creation is obsolete."
    echo "open=false" >> "$GITHUB_OUTPUT"
    ;;
  *)
    echo "Unexpected PR state '$state'; preview admission cannot be verified." >&2
    exit 1
    ;;
esac
