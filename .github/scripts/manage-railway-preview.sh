#!/usr/bin/env bash

set -euo pipefail

: "${RAILWAY_API_TOKEN:?}"
: "${RAILWAY_PROJECT_ID:?}"

ACTION="${1:-}"
PREVIEW_NAME=""
if test "$ACTION" != list-previews; then
	: "${PR_NUMBER:?}"
	[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid PR number" >&2; exit 2; }
	PREVIEW_NAME="lixray-pr-$PR_NUMBER"
fi
RAILWAY_BIN="${RAILWAY_BIN:-railway}"

graphql() {
	local payload="$1"
	local attempt response
	for attempt in 1 2 3; do
		if response="$(
			curl --fail --silent --show-error \
				--request POST \
				--url https://backboard.railway.com/graphql/v2 \
				--header "Authorization: Bearer $RAILWAY_API_TOKEN" \
				--header "Content-Type: application/json" \
				--data-binary "$payload"
		)"; then
			break
		fi
		if test "$attempt" -eq 3; then
			return 1
		fi
		echo "Railway API request failed; retrying ($attempt/3)." >&2
		sleep "$attempt"
	done
	if jq -e '.errors | length > 0' <<<"$response" >/dev/null; then
		jq -r '.errors[].message' <<<"$response" >&2
		return 1
	fi
	printf '%s\n' "$response"
}

list_environments() {
	local payload
	payload="$(
		jq -cn \
			--arg query 'query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }' \
			--arg project_id "$RAILWAY_PROJECT_ID" \
			'{query: $query, variables: {id: $project_id}}'
	)"
	graphql "$payload" | jq -c '[.data.project.environments.edges[].node]'
}

environment_id_by_name() {
	local environments="$1"
	local name="$2"
	local matches
	matches="$(jq -c --arg name "$name" '[.[] | select(.name == $name)]' <<<"$environments")"
	if test "$(jq 'length' <<<"$matches")" -gt 1; then
		echo "Multiple Railway environments are named $name; refusing an ambiguous operation." >&2
		return 1
	fi
	jq -r '.[0].id // empty' <<<"$matches"
}

ensure_preview() {
	local environments preview_id source_id payload response
	environments="$(list_environments)"
	preview_id="$(environment_id_by_name "$environments" "$PREVIEW_NAME")"
	if test -n "$preview_id"; then
		echo "Reusing Railway preview environment $PREVIEW_NAME ($preview_id)."
	else
		: "${RAILWAY_PREVIEW_BASE_ENVIRONMENT:?}"
		source_id="$(
			jq -r --arg source "$RAILWAY_PREVIEW_BASE_ENVIRONMENT" \
				'.[] | select(.id == $source or .name == $source) | .id' \
				<<<"$environments" | head -n 1
		)"
		if test -z "$source_id"; then
			echo "Railway preview base environment not found: $RAILWAY_PREVIEW_BASE_ENVIRONMENT" >&2
			return 1
		fi
		payload="$(
			jq -cn \
				--arg query 'mutation($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id name } }' \
				--arg project_id "$RAILWAY_PROJECT_ID" \
				--arg name "$PREVIEW_NAME" \
				--arg source_id "$source_id" \
				'{
					query: $query,
					variables: {input: {
						projectId: $project_id,
						name: $name,
						sourceEnvironmentId: $source_id,
						ephemeral: true,
						skipInitialDeploys: true
					}}
				}'
		)"
		response="$(graphql "$payload")"
		preview_id="$(jq -r '.data.environmentCreate.id // empty' <<<"$response")"
		test -n "$preview_id"
		echo "Created Railway preview environment $PREVIEW_NAME ($preview_id)."
	fi
	if test -n "${GITHUB_OUTPUT:-}"; then
		echo "environment_id=$preview_id" >>"$GITHUB_OUTPUT"
	fi
}

delete_preview() {
	local environments preview_id payload response protected
	environments="$(list_environments)"
	preview_id="$(environment_id_by_name "$environments" "$PREVIEW_NAME")"
	if test -z "$preview_id"; then
		echo "Railway preview environment $PREVIEW_NAME is already absent."
		return 0
	fi
	for protected in "${RAILWAY_PRODUCTION_ENVIRONMENT:-}" "${RAILWAY_PREVIEW_BASE_ENVIRONMENT:-}"; do
		if test -n "$protected" && { test "$protected" = "$preview_id" || test "$protected" = "$PREVIEW_NAME"; }; then
			echo "Refusing to delete a protected Railway environment." >&2
			return 1
		fi
	done
	payload="$(
		jq -cn \
			--arg query 'mutation($id: String!) { environmentDelete(id: $id) }' \
			--arg id "$preview_id" \
			'{query: $query, variables: {id: $id}}'
	)"
	response="$(graphql "$payload")"
	test "$(jq -r '.data.environmentDelete' <<<"$response")" = true
	echo "Deleted Railway preview environment $PREVIEW_NAME ($preview_id)."
}

preview_domain_from_json() {
	jq -r '
		[.. | objects | .domain? // empty |
			select(type == "string" and endswith(".up.railway.app"))][0] // empty
	'
}

resolve_preview_url() {
	: "${RAILWAY_WEB_SERVICE:?}"
	local environments preview_id domains domain attempt
	environments="$(list_environments)"
	preview_id="$(environment_id_by_name "$environments" "$PREVIEW_NAME")"
	if test -z "$preview_id"; then
		echo "Railway preview environment not found: $PREVIEW_NAME" >&2
		return 1
	fi

	domain=""
	for attempt in 1 2 3; do
		if domains="$(
			"$RAILWAY_BIN" domain list \
				--project "$RAILWAY_PROJECT_ID" \
				--environment "$preview_id" \
				--service "$RAILWAY_WEB_SERVICE" \
				--json
		)"; then
			domain="$(preview_domain_from_json <<<"$domains")"
		fi
		if test -n "$domain"; then
			break
		fi
		if domains="$(
			"$RAILWAY_BIN" domain \
				--project "$RAILWAY_PROJECT_ID" \
				--environment "$preview_id" \
				--service "$RAILWAY_WEB_SERVICE" \
				--json
		)"; then
			domain="$(preview_domain_from_json <<<"$domains")"
		fi
		if test -n "$domain"; then
			break
		fi
		echo "Railway preview domain is not ready; retrying ($attempt/3)." >&2
		sleep "$attempt"
	done
	if test -z "$domain"; then
		echo "Railway did not provide a public domain for $PREVIEW_NAME." >&2
		return 1
	fi

	echo "Railway preview URL: https://$domain"
	if test -n "${GITHUB_OUTPUT:-}"; then
		echo "preview_url=https://$domain" >>"$GITHUB_OUTPUT"
	fi
}

# Only a successfully fetched, explicitly closed PR permits deletion. API errors
# must never be interpreted as a closed PR (including permissions/404 failures).
delete_if_closed() {
	: "${GITHUB_REPOSITORY:?}"
	local state
	state="$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" --jq .state)"
	case "$state" in
		closed) delete_preview ;;
		open) echo "PR $PR_NUMBER is open; retaining its preview." ;;
		*) echo "Unknown PR state: $state" >&2; return 1 ;;
	esac
}

case "$ACTION" in
	list-previews)
		list_environments | jq -c '[.[] | .name | select(test("^lixray-pr-[1-9][0-9]*$")) | sub("^lixray-pr-"; "")] | unique'
		;;
	delete-if-closed) delete_if_closed ;;
	ensure) ensure_preview ;;
	delete) delete_preview ;;
	url) resolve_preview_url ;;
	*)
		echo "Usage: $0 ensure|delete|delete-if-closed|list-previews|url" >&2
		exit 2
		;;
esac
