#!/usr/bin/env bash
set -euo pipefail

: "${RAILWAY_API_TOKEN:?}"
: "${RAILWAY_PROJECT_ID:?}"
: "${RAILWAY_TARGET_ENVIRONMENT:?}"
: "${RAILWAY_WEB_SERVICE:?}"
RAILWAY_BIN="${RAILWAY_BIN:-railway}"

# Railway CLI 5.30 discovers public keys directly under ~/.ssh even when --key
# is explicit. Use a fresh file there, never overwrite or reuse an existing key.
umask 077
mkdir -p "${HOME:?}/.ssh"
key_file="$(mktemp "$HOME/.ssh/lixray-ci-XXXXXX")"
rm "$key_file"
fingerprint=""
registration_attempted=false
ssh_wrapper_dir=""
cleanup() {
	local result=$? revoked=false
	trap - EXIT
	if test "$registration_attempted" = true; then
		for attempt in 1 2 3; do
			if "$RAILWAY_BIN" ssh keys remove "$fingerprint" >"$key_file.cleanup" 2>&1; then
				revoked=true
				break
			fi
			# A failed registration may leave no matching key. CLI key lookup
			# confirms absence before attempting deletion.
			if grep -q 'Key not found:' "$key_file.cleanup"; then
				revoked=true
				break
			fi
			sleep "$attempt"
		done
		if test "$revoked" != true; then
			echo "Failed to revoke ephemeral Railway SSH key $fingerprint." >&2
			result=1
		fi
	fi
	rm -f "$key_file" "$key_file.pub" "$key_file.cleanup"
	if test -n "$ssh_wrapper_dir"; then rm -rf "$ssh_wrapper_dir"; fi
	exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ssh-keygen -q -t ed25519 -N '' -f "$key_file" -C "lixray-preview-${GITHUB_RUN_ID:-local}"
fingerprint="$(ssh-keygen -lf "$key_file.pub" | awk '{print $2}')"
# CLI 5.30 invokes the system ssh without a first-use policy. Scope TOFU to
# its production relay; default known_hosts/config still reject changed keys.
export LIXRAY_REAL_SSH="$(command -v ssh)"
ssh_wrapper_dir="$(mktemp -d)"
cat >"$ssh_wrapper_dir/ssh" <<'SSH'
#!/usr/bin/env bash
for argument in "$@"; do
    if [[ "$argument" == *@ssh.railway.com ]]; then
        exec "$LIXRAY_REAL_SSH" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$@"
    fi
done
exec "$LIXRAY_REAL_SSH" "$@"
SSH
chmod 700 "$ssh_wrapper_dir/ssh"
registration_attempted=true
"$RAILWAY_BIN" ssh keys add --key "$key_file.pub" --name "lixray-preview-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
PATH="$ssh_wrapper_dir:$PATH" "$RAILWAY_BIN" ssh --identity-file "$key_file" --project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_TARGET_ENVIRONMENT" --service "$RAILWAY_WEB_SERVICE" -- node /app/web-app/scripts/provision-repositories.mjs create-new
