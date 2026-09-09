#!/usr/bin/env bash

set -euo pipefail

: "${GHCR_READ_TOKEN:?}"
: "${GHCR_READ_USERNAME:?}"
: "${RAILWAY_API_TOKEN:?}"
: "${RAILWAY_PROJECT_ID:?}"
: "${RAILWAY_SERVER_SERVICE:?}"
: "${RAILWAY_WEB_SERVICE:?}"
: "${SERVER_IMAGE:?}"
: "${WEB_IMAGE:?}"

RAILWAY_TARGET_ENVIRONMENT="${RAILWAY_TARGET_ENVIRONMENT:-${RAILWAY_PRODUCTION_ENVIRONMENT:-}}"
RAILWAY_DEPLOY_POLICY="${RAILWAY_DEPLOY_POLICY:-production}"
RAILWAY_RELEASE_LABEL="${RAILWAY_RELEASE_LABEL:-production}"
: "${RAILWAY_TARGET_ENVIRONMENT:?}"

case "$RAILWAY_DEPLOY_POLICY" in
	production | pr) ;;
	*)
		echo "Unknown Railway deploy policy: $RAILWAY_DEPLOY_POLICY" >&2
		exit 1
		;;
esac

POLL_ATTEMPTS="${POLL_ATTEMPTS:-90}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
RAILWAY_BIN="${RAILWAY_BIN:-railway}"

list_deployments() {
	local service="$1" response
	if response="$("$RAILWAY_BIN" deployment list \
		--project "$RAILWAY_PROJECT_ID" \
		--environment "$RAILWAY_TARGET_ENVIRONMENT" \
		--service "$service" \
		--limit 1 --json 2>&1)"; then
		printf '%s\n' "$response"
	else
		printf '%s\n' "$response" >&2
		if [[ "$response" == *Environment*"not found"* ]]; then return 42; fi
		return 1
	fi
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
			--arg environment_id "$RAILWAY_TARGET_ENVIRONMENT" \
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

service_configuration_matches() {
	local service="$1"
	local image="$2"
	local deploy="$3"
	local payload response

	payload="$(
		jq -cn \
			--arg query 'query($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { source { image repo } numReplicas sleepApplication startCommand healthcheckPath healthcheckTimeout restartPolicyType restartPolicyMaxRetries overlapSeconds drainingSeconds } }' \
			--arg service_id "$service" \
			--arg environment_id "$RAILWAY_TARGET_ENVIRONMENT" \
			'{
				query: $query,
				variables: {
					serviceId: $service_id,
					environmentId: $environment_id
				}
			}'
	)"
	response="$(graphql "$payload")" || return 1

	jq -e \
		--arg image "$image" \
		--argjson deploy "$deploy" \
		'
			.data.serviceInstance as $actual |
			($deploy + {source: {image: $image}}) as $expected |
			all($expected | to_entries[];
				if .key == "source" then
					$actual.source.image == .value.image and ($actual.source.repo // null) == null
				else
					$actual[.key] == .value
				end
			)
		' <<<"$response" >/dev/null
}

deploy_service() {
	local service="$1"
	local response

	response="$(
		jq -cn \
			--arg query 'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }' \
			--arg service_id "$service" \
			--arg environment_id "$RAILWAY_TARGET_ENVIRONMENT" \
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

	deployments="$(list_deployments "$service")" || return $?
	jq -c '.[0] // {}' <<<"$deployments"
}

deployment_id() {
	jq -r '.id // empty' <<<"$1"
}

deployment_status() {
	jq -r '.status // "unknown"' <<<"$1"
}

deployment_can_be_reused() {
	case "$1" in
		unknown | FAILED | CRASHED | REMOVED | SKIPPED | CANCELED | CANCELLED) return 1 ;;
		*) return 0 ;;
	esac
}

deployment_is_healthy() {
	case "$1" in
		SUCCESS) return 0 ;;
		SLEEPING) test "$RAILWAY_DEPLOY_POLICY" = pr ;;
		*) return 1 ;;
	esac
}

deployment_is_expected() {
	local current="$1"
	local previous="$2"
	local reuse="$3"

	test -n "$current" || return 1
	if test "$reuse" = true; then
		test "$current" = "$previous"
	else
		test "$current" != "$previous"
	fi
}

print_deployment_logs() {
	local label="$1"
	local service="$2"
	local deployment="$3"
	if test -z "$deployment"; then
		return
	fi
	echo "::group::Railway $label deployment logs ($deployment)"
	if ! "$RAILWAY_BIN" logs \
		--project "$RAILWAY_PROJECT_ID" \
		--environment "$RAILWAY_TARGET_ENVIRONMENT" \
		--service "$service" \
		--lines 200 \
		"$deployment"; then
		echo "::warning::Could not read Railway $label deployment logs."
	fi
	echo "::endgroup::"
}

previous_deployment() {
	local service="$1"

	if latest_deployment "$service"; then
		return 0
	else
		echo "::warning::Could not read the previous Railway deployment for $service; continuing." >&2
		printf '{}\n'
	fi
}

previous_web_deployment="$(previous_deployment "$RAILWAY_WEB_SERVICE")"
previous_server_deployment="$(previous_deployment "$RAILWAY_SERVER_SERVICE")"
previous_web="$(deployment_id "$previous_web_deployment")"
previous_server="$(deployment_id "$previous_server_deployment")"
previous_web_status="$(deployment_status "$previous_web_deployment")"
previous_server_status="$(deployment_status "$previous_server_deployment")"

web_policy="$(jq -c --arg policy "$RAILWAY_DEPLOY_POLICY" '.deploy * .environments[$policy].deploy' web-app/railway.json)"
server_policy="$(jq -c --arg policy "$RAILWAY_DEPLOY_POLICY" '.deploy * .environments[$policy].deploy' railway.json)"

# Resolve the external web gateway before starting the server. The server's own
# Railway domain is not the public repository origin.
public_url="${LIXRAY_PUBLIC_URL:-}"
if test -z "$public_url"; then
	domains="$("$RAILWAY_BIN" domain list --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_TARGET_ENVIRONMENT" --service "$RAILWAY_WEB_SERVICE" --json)"
	public_domain="$(jq -r '[.. | objects | .domain? // empty | select(type == "string" and endswith(".up.railway.app"))][0] // empty' <<<"$domains")"
	if test -z "$public_domain"; then
		domains="$("$RAILWAY_BIN" domain --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_TARGET_ENVIRONMENT" --service "$RAILWAY_WEB_SERVICE" --json)"
		public_domain="$(jq -r '[.. | objects | .domain? // empty | select(type == "string" and endswith(".up.railway.app"))][0] // empty' <<<"$domains")"
	fi
	public_url="https://$public_domain"
fi
# Restrict this value to an HTTPS origin before embedding it in shell source.
if [[ ! "$public_url" =~ ^https://[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(:[0-9]+)?$ ]]; then
	echo "Expected an HTTPS web gateway origin for LIXRAY_PUBLIC_URL." >&2
	exit 1
fi
server_policy="$(jq -c --arg origin "$public_url" '.startCommand = ("env LIXRAY_PUBLIC_URL=" + $origin + " " + .startCommand)' <<<"$server_policy")"

reuse_web=false
reuse_server=false
if test -n "$previous_web" && deployment_can_be_reused "$previous_web_status" &&
	service_configuration_matches "$RAILWAY_WEB_SERVICE" "$WEB_IMAGE" "$web_policy"; then
	reuse_web=true
	echo "Reusing matching Railway web deployment $previous_web ($previous_web_status)."
fi
if test -n "$previous_server" && deployment_can_be_reused "$previous_server_status" &&
	service_configuration_matches "$RAILWAY_SERVER_SERVICE" "$SERVER_IMAGE" "$server_policy"; then
	reuse_server=true
	echo "Reusing matching Railway server deployment $previous_server ($previous_server_status)."
fi

update_service "$RAILWAY_WEB_SERVICE" "$WEB_IMAGE" "$web_policy"
# LixRay republishes the tested Lix artifact under its own GHCR package. New
# packages are private by default, so Railway must receive the same read-only
# registry credential used for the web image. Without it Railway fails before
# the server process starts and therefore emits no container logs.
update_service "$RAILWAY_SERVER_SERVICE" "$SERVER_IMAGE" "$server_policy"
if test "$reuse_web" = false; then
	deploy_service "$RAILWAY_WEB_SERVICE"
fi
if test "$reuse_server" = false; then
	deploy_service "$RAILWAY_SERVER_SERVICE"
fi

echo "Railway $RAILWAY_RELEASE_LABEL promotion is tracking both tested images."

last_web_status=""
last_server_status=""
web_id=""
server_id=""
web_status="unknown"
server_status="unknown"
web_read_failures=0
server_read_failures=0

for attempt in $(seq 1 "$POLL_ATTEMPTS"); do
	if web="$(latest_deployment "$RAILWAY_WEB_SERVICE")"; then
		web_id="$(deployment_id "$web")"
		web_status="$(deployment_status "$web")"
		web_read_failures=0
	else
		read_status=$?
		if test "$read_status" = 42; then
			echo "Railway environment no longer exists; stopping promotion." >&2
			exit 1
		fi
		web_read_failures=$((web_read_failures + 1))
		if test "$web_read_failures" -ge 3; then
			echo "Could not read web deployment three times; stopping promotion." >&2
			exit 1
		fi
		web_status="unknown"
		echo "::warning::Could not read web deployment on attempt $attempt."
	fi

	if server="$(latest_deployment "$RAILWAY_SERVER_SERVICE")"; then
		server_id="$(deployment_id "$server")"
		server_status="$(deployment_status "$server")"
		server_read_failures=0
	else
		read_status=$?
		if test "$read_status" = 42; then
			echo "Railway environment no longer exists; stopping promotion." >&2
			exit 1
		fi
		server_read_failures=$((server_read_failures + 1))
		if test "$server_read_failures" -ge 3; then
			echo "Could not read server deployment three times; stopping promotion." >&2
			exit 1
		fi
		server_status="unknown"
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
				echo "Railway $RAILWAY_RELEASE_LABEL deployment ended with $state." >&2
				print_deployment_logs "web" "$RAILWAY_WEB_SERVICE" "$web_id"
				print_deployment_logs "server" "$RAILWAY_SERVER_SERVICE" "$server_id"
				exit 1
				;;
		esac
	done

	web_is_expected=false
	server_is_expected=false
	if deployment_is_expected "$web_id" "$previous_web" "$reuse_web"; then
		web_is_expected=true
	fi
	if deployment_is_expected "$server_id" "$previous_server" "$reuse_server"; then
		server_is_expected=true
	fi

	if test "$web_is_expected" = true && deployment_is_healthy "$web_status" &&
		test "$server_is_expected" = true && deployment_is_healthy "$server_status"; then
		{
			echo "## Railway $RAILWAY_RELEASE_LABEL release"
			echo
			echo "| Service | Deployment | Image |"
			echo "| --- | --- | --- |"
			echo "| Web | \`$web_id\` | \`$WEB_IMAGE\` |"
			echo "| Server | \`$server_id\` | \`$SERVER_IMAGE\` |"
		} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
		if test -n "${GITHUB_OUTPUT:-}"; then
			echo "web_deployment_id=$web_id" >>"$GITHUB_OUTPUT"
			echo "server_deployment_id=$server_id" >>"$GITHUB_OUTPUT"
			echo "server_deployment_id=$server_id" >>"$GITHUB_OUTPUT"
		fi
		echo "Railway $RAILWAY_RELEASE_LABEL release is healthy."
		exit 0
	fi

	sleep "$POLL_INTERVAL_SECONDS"
done

echo "Railway $RAILWAY_RELEASE_LABEL release did not become healthy after $POLL_ATTEMPTS checks." >&2
echo "Web: ${web_id:-not started} $web_status" >&2
echo "Server: ${server_id:-not started} $server_status" >&2
print_deployment_logs "web" "$RAILWAY_WEB_SERVICE" "$web_id"
print_deployment_logs "server" "$RAILWAY_SERVER_SERVICE" "$server_id"
exit 1
