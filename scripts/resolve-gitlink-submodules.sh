#!/bin/sh

set -eu

if [ "$#" -eq 0 ]; then
	echo "usage: $0 <submodule-path>..." >&2
	exit 2
fi

missing_submodule=false
for submodule_path in "$@"; do
	if [ ! -d "$submodule_path" ] || [ -z "$(find "$submodule_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
		missing_submodule=true
		break
	fi
done

if [ "$missing_submodule" = false ]; then
	exit 0
fi

: "${RAILWAY_GIT_COMMIT_SHA:?Railway must provide the parent repository commit SHA}"
: "${RAILWAY_GIT_REPO_OWNER:?Railway must provide the parent repository owner}"
: "${RAILWAY_GIT_REPO_NAME:?Railway must provide the parent repository name}"

parent_git_dir="$(mktemp -d)"
trap 'rm -rf "$parent_git_dir"' EXIT HUP INT TERM

git -C "$parent_git_dir" init --quiet
git -C "$parent_git_dir" remote add origin \
	"https://github.com/${RAILWAY_GIT_REPO_OWNER}/${RAILWAY_GIT_REPO_NAME}.git"
git -C "$parent_git_dir" fetch --quiet --depth 1 --filter=blob:none \
	origin "$RAILWAY_GIT_COMMIT_SHA"

for submodule_path in "$@"; do
	if [ -d "$submodule_path" ] && [ -n "$(find "$submodule_path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
		continue
	fi

	tree_entry="$(git -C "$parent_git_dir" ls-tree FETCH_HEAD -- "$submodule_path")"
	mode="$(printf '%s\n' "$tree_entry" | awk '{print $1}')"
	kind="$(printf '%s\n' "$tree_entry" | awk '{print $2}')"
	revision="$(printf '%s\n' "$tree_entry" | awk '{print $3}')"
	if [ "$mode" != "160000" ] || [ "$kind" != "commit" ] || [ "${#revision}" -ne 40 ]; then
		echo "$submodule_path is not a gitlink in parent commit $RAILWAY_GIT_COMMIT_SHA" >&2
		exit 1
	fi
	case "$revision" in
		*[!0-9a-f]*)
			echo "$submodule_path resolved to an invalid revision" >&2
			exit 1
			;;
	esac

	submodule_url="$(git config -f .gitmodules --get "submodule.${submodule_path}.url")"
	case "$submodule_url" in
		https://github.com/*.git) ;;
		*)
			echo "$submodule_path does not use a supported GitHub URL" >&2
			exit 1
			;;
	esac

	mkdir -p "$submodule_path"
	archive_path="$parent_git_dir/submodule.tar.gz"
	curl -fsSL "${submodule_url%.git}/archive/${revision}.tar.gz" -o "$archive_path"
	tar -xzf "$archive_path" -C "$submodule_path" --strip-components=1
	rm "$archive_path"
done
