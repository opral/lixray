#!/usr/bin/env bash

set -euo pipefail

: "${GHCR_READ_TOKEN:?}"
: "${GHCR_READ_USERNAME:?}"
: "${GITHUB_SHA:?}"
: "${IMAGE:?}"
: "${RAILWAY_API_TOKEN:?}"
: "${RAILWAY_PRODUCTION_ENVIRONMENT:?}"
: "${RAILWAY_PROJECT_ID:?}"
: "${RAILWAY_SERVER_SERVICE:?}"
: "${RAILWAY_WEB_SERVICE:?}"

list_deployments() {
	local service="$1"
	local limit="$2"
	railway deployment list \
		--project "$RAILWAY_PROJECT_ID" \
		--environment "$RAILWAY_PRODUCTION_ENVIRONMENT" \
		--service "$service" \
		--limit "$limit" \
		--json
}

previous_server_deployment=""
if deployments="$(list_deployments "$RAILWAY_SERVER_SERVICE" 1)"; then
	previous_server_deployment="$(
		jq -r '.[0].id // empty' <<<"$deployments"
	)"
else
	echo "::warning::Could not read the previous Railway server deployment; continuing with promotion."
fi

update_response="$(
	jq -n \
		--arg query 'mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }' \
		--arg service_id "$RAILWAY_SERVER_SERVICE" \
		--arg environment_id "$RAILWAY_PRODUCTION_ENVIRONMENT" \
		--arg image "$IMAGE" \
		--arg username "$GHCR_READ_USERNAME" \
		--arg password "$GHCR_READ_TOKEN" \
		'{
			query: $query,
			variables: {
				serviceId: $service_id,
				environmentId: $environment_id,
				input: {
					source: {image: $image},
					registryCredentials: {
						username: $username,
						password: $password
					}
				}
			}
		}' |
		curl --fail --silent --show-error \
			--request POST \
			--url https://backboard.railway.com/graphql/v2 \
			--header "Authorization: Bearer $RAILWAY_API_TOKEN" \
			--header "Content-Type: application/json" \
			--data-binary @-
)"
if jq -e '.errors | length > 0' <<<"$update_response" >/dev/null; then
	jq -r '.errors[].message' <<<"$update_response" >&2
	exit 1
fi
test "$(jq -r '.data.serviceInstanceUpdate' <<<"$update_response")" = true

server_started=false
server_deployment_id=""
server_status=""
web_deployment_id=""
web_status=""

for attempt in $(seq 1 90); do
	if web_deployments="$(list_deployments "$RAILWAY_WEB_SERVICE" 20)"; then
		web_deployment="$(
			jq -c --arg sha "$GITHUB_SHA" \
				'[.[] | select(.meta.commitHash == $sha)][0] // {}' \
				<<<"$web_deployments"
		)"
		web_deployment_id="$(jq -r '.id // empty' <<<"$web_deployment")"
		web_status="$(jq -r '.status // empty' <<<"$web_deployment")"
	else
		echo "::warning::Railway web deployment lookup failed on attempt $attempt; retrying."
	fi

	case "$web_status" in
		FAILED | CRASHED | REMOVED | SKIPPED)
			echo "Railway web deployment $web_deployment_id for $GITHUB_SHA ended with $web_status." >&2
			exit 1
			;;
	esac

	# Railway builds the web service from GitHub. Start the prebuilt server
	# promotion only once the web image has finished building, keeping their
	# activation times close without rebuilding the web app in CI.
	if test "$server_started" = false &&
		{ test "$web_status" = DEPLOYING || test "$web_status" = SUCCESS; }; then
		deploy_response="$(
			jq -n \
				--arg query 'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }' \
				--arg service_id "$RAILWAY_SERVER_SERVICE" \
				--arg environment_id "$RAILWAY_PRODUCTION_ENVIRONMENT" \
				'{
					query: $query,
					variables: {
						serviceId: $service_id,
						environmentId: $environment_id
					}
				}' |
				curl --fail --silent --show-error \
					--request POST \
					--url https://backboard.railway.com/graphql/v2 \
					--header "Authorization: Bearer $RAILWAY_API_TOKEN" \
					--header "Content-Type: application/json" \
					--data-binary @-
		)"
		if jq -e '.errors | length > 0' <<<"$deploy_response" >/dev/null; then
			jq -r '.errors[].message' <<<"$deploy_response" >&2
			exit 1
		fi
		test "$(jq -r '.data.serviceInstanceDeploy' <<<"$deploy_response")" = true
		server_started=true
		echo "Railway web is $web_status; started server promotion."
	fi

	if test "$server_started" = true; then
		if server_deployments="$(list_deployments "$RAILWAY_SERVER_SERVICE" 1)"; then
			server_deployment_id="$(
				jq -r '.[0].id // empty' <<<"$server_deployments"
			)"
			server_status="$(
				jq -r '.[0].status // empty' <<<"$server_deployments"
			)"
		else
			echo "::warning::Railway server deployment lookup failed on attempt $attempt; retrying."
		fi

		if test -n "$server_deployment_id" &&
			test "$server_deployment_id" != "$previous_server_deployment"; then
			case "$server_status" in
				FAILED | CRASHED | REMOVED)
					echo "Railway server deployment $server_deployment_id ended with $server_status." >&2
					exit 1
					;;
			esac
		fi
	fi

	if test "$web_status" = SUCCESS &&
		test -n "$server_deployment_id" &&
		test "$server_deployment_id" != "$previous_server_deployment" &&
		test "$server_status" = SUCCESS; then
		echo "Railway production release $GITHUB_SHA is healthy."
		echo "Web deployment: $web_deployment_id"
		echo "Server deployment: $server_deployment_id ($IMAGE)"
		exit 0
	fi

	sleep 10
done

echo "Railway production release $GITHUB_SHA did not become healthy within 15 minutes." >&2
echo "Web: ${web_deployment_id:-not found} ${web_status:-unknown}" >&2
echo "Server: ${server_deployment_id:-not started} ${server_status:-unknown}" >&2
exit 1
