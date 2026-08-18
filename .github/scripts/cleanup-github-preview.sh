#!/usr/bin/env bash

set -euo pipefail

: "${PR_NUMBER:?}"
: "${GITHUB_REPOSITORY:?}"

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
	echo "PR_NUMBER must be a positive integer, got: $PR_NUMBER" >&2
	exit 2
fi

PRIMARY_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
ADMIN_TOKEN="${GITHUB_ENVIRONMENT_ADMIN_TOKEN:-${REPOSITORY_ADMIN_TOKEN:-}}"
if test -z "$PRIMARY_TOKEN"; then
	echo "GITHUB_TOKEN is required to clean GitHub preview environments." >&2
	exit 1
fi

PREVIEW_NAMES=(
	"lixray-pr-$PR_NUMBER"
	"lixray / lixray-pr-$PR_NUMBER"
)

encode_name() {
	jq -nr --arg name "$1" '$name | @uri'
}

LAST_HTTP_STATUS=0
LAST_GH_ERROR=""

call_gh() {
	local token="$1"
	shift
	local stdout_file stderr_file status
	stdout_file="$(mktemp)"
	stderr_file="$(mktemp)"
	set +e
	GH_TOKEN="$token" GH_PROMPT_DISABLED=1 gh api "$@" >"$stdout_file" 2>"$stderr_file"
	status=$?
	set -e
	LAST_GH_ERROR="$(cat "$stderr_file")"
	if test "$status" -eq 0; then
		LAST_HTTP_STATUS=200
		cat "$stdout_file"
		rm -f "$stdout_file" "$stderr_file"
		return 0
	fi
	if [[ "$LAST_GH_ERROR" =~ HTTP\ ([0-9]+) ]]; then
		LAST_HTTP_STATUS="${BASH_REMATCH[1]}"
	else
		LAST_HTTP_STATUS=1
	fi
	rm -f "$stdout_file" "$stderr_file"
	return 1
}

fail_forbidden() {
	echo "GitHub denied preview cleanup with GITHUB_TOKEN (HTTP 403)." >&2
	echo "Grant this workflow 'environments: write' and 'deployments: write'." >&2
	echo "If those permissions are insufficient, set optional GITHUB_ENVIRONMENT_ADMIN_TOKEN as a repository secret or Infisical /ci variable." >&2
	exit 1
}

# 0 success, 4 not found, 9 already inactive/conflict, 1 other failure.
github_api() {
	if call_gh "$PRIMARY_TOKEN" "$@"; then
		return 0
	fi
	if test "$LAST_HTTP_STATUS" -eq 404; then
		return 4
	fi
	if test "$LAST_HTTP_STATUS" -eq 409 || test "$LAST_HTTP_STATUS" -eq 422; then
		return 9
	fi
	if test "$LAST_HTTP_STATUS" -eq 403; then
		if test -z "$ADMIN_TOKEN" || test "$ADMIN_TOKEN" = "$PRIMARY_TOKEN"; then
			fail_forbidden
		fi
		echo "GITHUB_TOKEN was denied; retrying with GITHUB_ENVIRONMENT_ADMIN_TOKEN." >&2
		if call_gh "$ADMIN_TOKEN" "$@"; then
			return 0
		fi
		if test "$LAST_HTTP_STATUS" -eq 404; then
			return 4
		fi
		if test "$LAST_HTTP_STATUS" -eq 409 || test "$LAST_HTTP_STATUS" -eq 422; then
			return 9
		fi
		if test "$LAST_HTTP_STATUS" -eq 403; then
			fail_forbidden
		fi
	fi
	echo "GitHub API request failed (HTTP ${LAST_HTTP_STATUS}): ${LAST_GH_ERROR}" >&2
	return 1
}

list_deployment_ids() {
	local encoded="$1"
	local page=1
	local response count status
	while true; do
		status=0
		response="$(github_api "repos/${GITHUB_REPOSITORY}/deployments?environment=${encoded}&per_page=100&page=${page}")" || status=$?
		if test "$status" -eq 4; then
			return 0
		fi
		if test "$status" -ne 0; then
			return "$status"
		fi
		jq -r '.[]?.id // empty' <<<"$response"
		count="$(jq 'if type == "array" then length else 0 end' <<<"$response")"
		if test "$count" -lt 100; then
			break
		fi
		page=$((page + 1))
	done
}

inactivate_deployment() {
	local id="$1"
	local status=0
	github_api --method POST \
		"repos/${GITHUB_REPOSITORY}/deployments/${id}/statuses" \
		--field state=inactive \
		--field description="Preview cleaned up after pull request close" \
		>/dev/null || status=$?
	if test "$status" -eq 0 || test "$status" -eq 9; then
		return 0
	fi
	if test "$status" -eq 4; then
		echo "Deployment $id is already absent."
		return 0
	fi
	return "$status"
}

delete_deployment() {
	local id="$1"
	local status=0
	github_api --method DELETE \
		"repos/${GITHUB_REPOSITORY}/deployments/${id}" \
		>/dev/null || status=$?
	if test "$status" -eq 0 || test "$status" -eq 4; then
		return 0
	fi
	return "$status"
}

delete_environment() {
	local name="$1"
	local encoded="$2"
	local status=0
	github_api --method DELETE \
		"repos/${GITHUB_REPOSITORY}/environments/${encoded}" \
		>/dev/null || status=$?
	if test "$status" -eq 0; then
		echo "Deleted GitHub preview environment $name."
		return 0
	fi
	if test "$status" -eq 4; then
		echo "GitHub preview environment $name is already absent."
		return 0
	fi
	return "$status"
}

cleanup_environment() {
	local name="$1"
	local encoded ids
	encoded="$(encode_name "$name")"
	echo "Cleaning GitHub preview environment $name."
	ids="$(list_deployment_ids "$encoded")"
	while read -r id; do
		test -n "$id" || continue
		inactivate_deployment "$id"
		delete_deployment "$id"
		echo "Removed GitHub deployment $id from $name."
	done <<<"$ids"
	delete_environment "$name" "$encoded"
}

for preview_name in "${PREVIEW_NAMES[@]}"; do
	cleanup_environment "$preview_name"
done
