#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_OUTPUT:?}"
: "${GITHUB_REPOSITORY_OWNER:?}"

tree="$(git rev-parse 'HEAD^{tree}')"
repository="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/lixray-server"
tag="$repository:tree-$tree"

for attempt in $(seq 1 75); do
	if digest="$(
		docker buildx imagetools inspect "$tag" \
			--format '{{json .Manifest.Digest}}' 2>/dev/null |
			tr -d '"'
	)" && test -n "$digest"; then
		image="$repository@$digest"
		docker pull "$image"
		echo "image=$image" >> "$GITHUB_OUTPUT"
		echo "Testing $image"
		exit 0
	fi
	echo "Waiting for server image $tag ($attempt/75)"
	sleep 10
done

echo "Server image $tag was not published within 12.5 minutes." >&2
exit 1
