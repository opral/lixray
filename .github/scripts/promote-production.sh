#!/usr/bin/env bash

set -euo pipefail

: "${GHCR_READ_TOKEN:?}"
: "${GHCR_READ_USERNAME:?}"
: "${RAILWAY_API_TOKEN:?}"
: "${RAILWAY_PRODUCTION_ENVIRONMENT:?}"
: "${RAILWAY_PROJECT_ID:?}"
: "${RAILWAY_SERVER_SERVICE:?}"
: "${RAILWAY_WEB_SERVICE:?}"
: "${SERVER_IMAGE:?}"
: "${WEB_IMAGE:?}"

POLL_ATTEMPTS="${POLL_ATTEMPTS:-60}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
RAILWAY_BIN="${RAILWAY_BIN:-railway}"

list_deployments() {
	local service="$1"
	"$RAILWAY_BIN" deployment list \
		--project "$RAILWAY_PROJECT_ID" \
		--environment "$RAILWAY_PRODUCTION_ENVIRONMENT" \
		--service "$service" \
		--limit 1 \
		--json
}

graphql() {
	local payload="$1"
	local response=""
	local attempt

	for attempt in 1 2 3; do
		if response="$(
			curl --fail --silent --show-error \
				--request POST \
				--url https://backboard.railway.com/graphql/v2 \
				--header "Authorization: Bearer $RAILWAY_API_TOKEN" \
				--header "Content-Type: application/json" \
				--data-binary "$payload"
		)"; then
			if jq -e '.errors | length > 0' <<<"$response" >/dev/null; then
				jq -r '.errors[].message' <<<"$response" >&2
				return 1
			fi
			printf '%s\n' "$response"
			return 0
		fi
		echo "::warning::Railway API request failed on attempt $attempt; retrying."
		sleep "$attempt"
	done

	return 1
}

update_service() {
	local service="$1"
	local image="$2"
	local deploy="$3"
	local response

	response="$(
		jq -cn \
			--arg query 'mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }' \
			--arg service_id "$service" \
			--arg environment_id "$RAILWAY_PRODUCTION_ENVIRONMENT" \
			--arg image "$image" \
			--arg username "$GHCR_READ_USERNAME" \
			--arg password "$GHCR_READ_TOKEN" \
			--argjson deploy "$deploy" \
			'{
				query: $query,
				variables: {
					serviceId: $service_id,
					environmentId: $environment_id,
					input: ($deploy + {
						source: {image: $image},
						registryCredentials: {
							username: $username,
							password: $password
						}
					})
				}
			}'
	)"
	response="$(graphql "$response")"
	test "$(jq -r '.data.serviceInstanceUpdate' <<<"$response")" = true
}

deploy_service() {
	local service="$1"
	local response

	response="$(
		jq -cn \
			--arg query 'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }' \
			--arg service_id "$service" \
			--arg environment_id "$RAILWAY_PRODUCTION_ENVIRONMENT" \
			'{
				query: $query,
				variables: {
					serviceId: $service_id,
					environmentId: $environment_id
				}
			}'
	)"
	response="$(graphql "$response")"
	test "$(jq -r '.data.serviceInstanceDeploy' <<<"$response")" = true
}

latest_deployment() {
	local service="$1"
	local deployments

	deployments="$(list_deployments "$service")"
	jq -c '.[0] // {}' <<<"$deployments"
}

deployment_id() {
	jq -r '.id // empty' <<<"$1"
}

deployment_status() {
	jq -r '.status // "unknown"' <<<"$1"
}

previous_deployment_id() {
	local service="$1"
	local deployment

	if deployment="$(latest_deployment "$service")"; then
		deployment_id "$deployment"
	else
		echo "::warning::Could not read the previous Railway deployment for $service; continuing." >&2
		printf '\n'
	fi
}

previous_web="$(previous_deployment_id "$RAILWAY_WEB_SERVICE")"
previous_server="$(previous_deployment_id "$RAILWAY_SERVER_SERVICE")"

web_policy="$(jq -c '.deploy * .environments.production.deploy' web-app/railway.json)"
server_policy="$(jq -c '.deploy * .environments.production.deploy' railway.json)"

update_service "$RAILWAY_WEB_SERVICE" "$WEB_IMAGE" "$web_policy"
update_service "$RAILWAY_SERVER_SERVICE" "$SERVER_IMAGE" "$server_policy"
deploy_service "$RAILWAY_WEB_SERVICE"
deploy_service "$RAILWAY_SERVER_SERVICE"

echo "Started Railway production deployment for both tested images."

last_web_status=""
last_server_status=""
web_id=""
server_id=""
web_status="unknown"
server_status="unknown"

for attempt in $(seq 1 "$POLL_ATTEMPTS"); do
	if web="$(latest_deployment "$RAILWAY_WEB_SERVICE")"; then
		web_id="$(deployment_id "$web")"
		web_status="$(deployment_status "$web")"
	else
		echo "::warning::Could not read web deployment on attempt $attempt."
	fi

	if server="$(latest_deployment "$RAILWAY_SERVER_SERVICE")"; then
		server_id="$(deployment_id "$server")"
		server_status="$(deployment_status "$server")"
	else
		echo "::warning::Could not read server deployment on attempt $attempt."
	fi

	if test "$web_status" != "$last_web_status"; then
		echo "Web deployment ${web_id:-not started}: $web_status"
		last_web_status="$web_status"
	fi
	if test "$server_status" != "$last_server_status"; then
		echo "Server deployment ${server_id:-not started}: $server_status"
		last_server_status="$server_status"
	fi

	for state in "$web_status" "$server_status"; do
		case "$state" in
			FAILED | CRASHED | REMOVED | SKIPPED | CANCELED | CANCELLED)
				echo "Railway production deployment ended with $state." >&2
				exit 1
				;;
		esac
	done

	if test -n "$web_id" && test "$web_id" != "$previous_web" &&
		test "$web_status" = SUCCESS &&
		test -n "$server_id" && test "$server_id" != "$previous_server" &&
		test "$server_status" = SUCCESS; then
		{
			echo "## Production release"
			echo
			echo "| Service | Deployment | Image |"
			echo "| --- | --- | --- |"
			echo "| Web | \`$web_id\` | \`$WEB_IMAGE\` |"
			echo "| Server | \`$server_id\` | \`$SERVER_IMAGE\` |"
		} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
		echo "Railway production release is healthy."
		exit 0
	fi

	sleep "$POLL_INTERVAL_SECONDS"
done

echo "Railway production release did not become healthy after $POLL_ATTEMPTS checks." >&2
echo "Web: ${web_id:-not started} $web_status" >&2
echo "Server: ${server_id:-not started} $server_status" >&2
exit 1
