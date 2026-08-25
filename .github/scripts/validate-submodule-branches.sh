#!/usr/bin/env bash
set -euo pipefail

git submodule foreach '
  branch=$(git config -f "$toplevel/.gitmodules" "submodule.$name.branch" || :)
  test -z "$branch" && exit 0

  if test "$(git rev-parse --is-shallow-repository)" = "true"; then
    git fetch --no-tags --unshallow origin "refs/heads/$branch"
  else
    git fetch --no-tags origin "refs/heads/$branch"
  fi

  git merge-base --is-ancestor "$sha1" FETCH_HEAD || {
    echo "$sm_path: $sha1 is not reachable from origin/$branch"
    exit 1
  }
'
