#!/usr/bin/env bash

set -euo pipefail

: "${GHCR_READ_TOKEN:?}"
: "${GHCR_READ_USERNAME:?}"
: "${IMAGE:?}"
: "${RAILWAY_API_TOKEN:?}"
: "${RAILWAY_PRODUCTION_ENVIRONMENT:?}"
: "${RAILWAY_PROJECT_ID:?}"
: "${RAILWAY_SERVER_SERVICE:?}"

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
					registryCredentials: {username: $username, password: $password}
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

previous_id="$(
	railway deployment list \
		--project "$RAILWAY_PROJECT_ID" \
		--environment "$RAILWAY_PRODUCTION_ENVIRONMENT" \
		--service "$RAILWAY_SERVER_SERVICE" \
		--limit 1 \
		--json |
		jq -r '.[0].id // empty'
)"

deploy_response="$(
	jq -n \
		--arg query 'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }' \
		--arg service_id "$RAILWAY_SERVER_SERVICE" \
		--arg environment_id "$RAILWAY_PRODUCTION_ENVIRONMENT" \
		'{query: $query, variables: {serviceId: $service_id, environmentId: $environment_id}}' |
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

for _attempt in $(seq 1 60); do
	deployment="$(
		railway deployment list \
			--project "$RAILWAY_PROJECT_ID" \
			--environment "$RAILWAY_PRODUCTION_ENVIRONMENT" \
			--service "$RAILWAY_SERVER_SERVICE" \
			--limit 1 \
			--json
	)"
	deployment_id="$(jq -r '.[0].id // empty' <<<"$deployment")"
	status="$(jq -r '.[0].status // empty' <<<"$deployment")"
	if test -n "$deployment_id" && test "$deployment_id" != "$previous_id"; then
		case "$status" in
		SUCCESS)
			echo "Benchmark server is running $IMAGE"
			exit 0
			;;
		FAILED | CRASHED | REMOVED)
			echo "Benchmark server deployment ended with $status." >&2
			exit 1
			;;
		esac
	fi
	sleep 10
done

echo "Benchmark server deployment did not become healthy within 10 minutes." >&2
exit 1
